// 境內基金經理人 — 官方來源：基金資訊觀測站（fundclear.com.tw，SITCA+集保結算所共同建置）。
// 2026-11-05使用者核准：經理人改以此為準，取代先前shadow-off的Yahoo版本（見
// app/api/cron/cloud-fund-allocation-sync/route.ts的更正）。
//
// 用無頭瀏覽器打開官方頁面 https://www.fundclear.com.tw/fund-basic-info?site=onshore&key={基金統編}，
// 點「基金報告書」→「基金資料」（模擬使用者操作），攔截頁面自己觸發的
// POST /api/onshore/fund-basic/query-details 回應讀取 basicProfile.fnManager——不猜測/組裝這個
// API的請求格式（曾經嘗試直接POST猜欄位名稱，被平台安全分類器擋下，正確作法是只讀頁面自己送出
// 的請求），不讀/重放cookie、不手動加header、不偽裝User-Agent（沿用hnfunds.ts的
// skipUserAgentOverride）。
//
// 基金層級：境內基金同一檔基金的不同級別在funds表裡是各自獨立的列（例如19330754A/B/C/D），
// 但fundclear官網同一檔基金的經理人是基金層級共用的——用「代碼去掉結尾英文字母」當base stem分組，
// 一組只打一次請求，寫入時套用到該組所有funds.id，避免為同一個經理人資料重複打4次請求。
import { withPage } from "../etf-holdings-engine/adapters/browserUtil";
import { prisma } from "../prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint, type BoundedDbOptions } from "../cloud-ingestion/runContext";

const PAGE_URL = (code: string) => `https://www.fundclear.com.tw/fund-basic-info?site=onshore&key=${code}`;
const REQUEST_SPACING_MS = 3_200;
const GOTO_TIMEOUT_MS = 25_000;
const CLICK_WAIT_TIMEOUT_MS = 15_000;
const DETAILS_RESPONSE_TIMEOUT_MS = 20_000;
const SOURCE = "FUNDCLEAR_ONSHORE_FUND_DETAILS";
const CHECKPOINT_KEY = "fundclear-onshore-manager-sync:cursor";
const CHECKPOINT_BOUND: BoundedDbOptions = { maxWaitMs: 5_000, statementTimeoutMs: 10_000, timeoutMs: 15_000 };

export function isFundclearManagerSyncWriteEnabled(): boolean {
  return process.env.FUNDCLEAR_MANAGER_SYNC_WRITE?.trim() === "on";
}

export class FundclearBlockedError extends Error {}

type QueryDetailsResponse = {
  basicProfile?: { fnFundno?: string; fnManager?: string | null; organizName?: string } | null;
};

export type FundclearManagerResult = { code: string; manager: string | null; organizName: string | null; elapsedMs: number };

async function clickByExactText(page: import("puppeteer-core").Page, text: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (t: string) => Array.from(document.querySelectorAll("body *")).some((el) => el.children.length === 0 && (el.textContent ?? "").trim() === t),
    { timeout: timeoutMs },
    text,
  );
  await page.evaluate((t: string) => {
    const el = Array.from(document.querySelectorAll("body *")).find((e) => e.children.length === 0 && (e.textContent ?? "").trim() === t);
    (el as HTMLElement | undefined)?.click();
  }, text);
}

function looksLikeChallengePage(bodyText: string): boolean {
  return /checking your browser|cloudflare|驗證您是真人|請稍候.{0,20}驗證|unusual traffic|automated queries/i.test(bodyText);
}

/** 用無頭瀏覽器打開官方頁面，讀取該代表碼的基金經理人（基金層級，呼叫端自行套用到同組其他級別）。*/
export async function fetchFundclearManager(code: string): Promise<FundclearManagerResult> {
  const t0 = Date.now();
  return withPage(
    async (page) => {
      const captured: QueryDetailsResponse[] = [];
      const onResponse = async (res: import("puppeteer-core").HTTPResponse) => {
        if (res.url().includes("/api/onshore/fund-basic/query-details") && res.request().method() === "POST") {
          const status = res.status();
          if (status === 401 || status === 403 || status === 429) throw new FundclearBlockedError(`FUNDCLEAR_HTTP_${status}_${code}`);
          try {
            captured.push(await res.json());
          } catch {
            /* ignore non-JSON responses */
          }
        }
      };
      page.on("response", onResponse);
      try {
        await page.goto(PAGE_URL(code), { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (looksLikeChallengePage(bodyText)) throw new FundclearBlockedError(`FUNDCLEAR_CHALLENGE_PAGE_${code}`);

        await clickByExactText(page, "基金報告書", CLICK_WAIT_TIMEOUT_MS);
        await new Promise((r) => setTimeout(r, 1200));
        await clickByExactText(page, "基金資料", 4_000).catch(() => {
          /* 有些基金類型（例如純ETF連結）可能沒有這個子分頁文字完全一致，仍然等待query-details回應 */
        });

        const deadline = Date.now() + DETAILS_RESPONSE_TIMEOUT_MS;
        while (captured.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        if (!captured.length) throw new Error(`FUNDCLEAR_NO_DETAILS_RESPONSE_${code}`);
      } finally {
        page.off("response", onResponse);
      }

      const profile = captured[captured.length - 1]?.basicProfile;
      return {
        code,
        manager: profile?.fnManager?.trim() || null,
        organizName: profile?.organizName ?? null,
        elapsedMs: Date.now() - t0,
      };
    },
    undefined,
    undefined,
    { skipUserAgentOverride: true },
  );
}

export function baseFundStem(code: string): string {
  return code.replace(/[A-Z]+$/, "");
}

export type ManagerSyncRunResult = {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  groupsAttempted: number;
  groupsWritten: number;
  groupsFailed: number;
  blocked: boolean;
  failedDetail: Array<{ stem: string; error: string }>;
  reachedEnd: boolean;
  sampleResults: FundclearManagerResult[];
};

const DOMESTIC = `(f.data_provider IS NULL OR f.data_provider = 'SITCA')`;

/** 補齊境內基金（tw_purchasable_classification APPROVED）缺經理人的部分。同一個base stem只打一次
 * 請求，寫入套用到該組所有funds.id——不是每一個share class都重打。*/
export async function runFundclearManagerSync(deadlineAt: number): Promise<ManagerSyncRunResult> {
  const startedMs = Date.now();
  const writeEnabled = isFundclearManagerSyncWriteEnabled();

  const rows = await prisma.$queryRawUnsafe<{ id: string; code: string }[]>(
    `SELECT f.id, f.code
     FROM funds f
     JOIN tw_purchasable_classification c ON c.asset_id = f.id AND c.asset_type = 'FUND' AND c.status = 'APPROVED'
     WHERE ${DOMESTIC} AND f.code IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fund_manager_assignments a WHERE a.fund_id = f.id AND a.end_date IS NULL)`,
  );

  const groups = new Map<string, string[]>(); // stem -> fund ids sharing it
  const repCodeByStem = new Map<string, string>(); // stem -> representative code to fetch
  for (const r of rows) {
    const stem = baseFundStem(r.code);
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem)!.push(r.id);
    const currentRep = repCodeByStem.get(stem);
    if (!currentRep || r.code < currentRep) repCodeByStem.set(stem, r.code);
  }
  const stems = [...groups.keys()].sort();

  const checkpoint = await readCheckpoint(CHECKPOINT_KEY, CHECKPOINT_BOUND);
  const startIndex = checkpoint?.lastSymbol ? stems.indexOf(checkpoint.lastSymbol) + 1 : 0;

  const JOB = "FUNDCLEAR_ONSHORE_MANAGER_SYNC";
  const today = new Date().toISOString().slice(0, 10);
  const { runId, skipped } = await beginRun(
    { jobName: JOB, provider: "FUNDCLEAR_ONSHORE", runKey: `${JOB}:${today}:from-${Math.max(startIndex, 0)}`, universeCount: stems.length, batchSize: stems.length - Math.max(startIndex, 0), checkpointBefore: checkpoint },
    CHECKPOINT_BOUND,
  );
  if (skipped) {
    return { ok: true, skipped: true, reason: "run_key already present", groupsAttempted: 0, groupsWritten: 0, groupsFailed: 0, blocked: false, failedDetail: [], reachedEnd: false, sampleResults: [] };
  }

  let groupsAttempted = 0, groupsWritten = 0, groupsFailed = 0;
  let blocked = false;
  const failedDetail: Array<{ stem: string; error: string }> = [];
  const sampleResults: FundclearManagerResult[] = [];
  let lastStem: string | null = checkpoint?.lastSymbol ?? null;
  let index = Math.max(startIndex, 0);

  for (; index < stems.length; index++) {
    if (Date.now() >= deadlineAt) break;
    const stem = stems[index];
    const repCode = repCodeByStem.get(stem)!;
    const fundIds = groups.get(stem)!;
    groupsAttempted++;

    try {
      const result = await fetchFundclearManager(repCode);
      if (sampleResults.length < 10) sampleResults.push(result);
      if (result.manager) {
        if (writeEnabled) {
          await prisma.$transaction(async (tx) => {
            const existing = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM fund_managers WHERE name = $1 AND source = $2 LIMIT 1`, result.manager, SOURCE);
            const managerId = existing[0]?.id ?? (await tx.$queryRawUnsafe<{ id: string }[]>(
              `INSERT INTO fund_managers (id, name, source, source_record_id, verification_status, created_at, updated_at)
               VALUES (gen_random_uuid()::text, $1, $2, $3, 'OFFICIAL_SOURCE', NOW(), NOW()) RETURNING id`,
              result.manager, SOURCE, repCode,
            ))[0].id;
            for (const fundId of fundIds) {
              // 2026-11-05使用者核准：經理人改以本來源為準，既有其他來源（例如Yahoo）的現任
              // assignment先end-date（不刪除，保留歷史），再寫入這筆官方來源的現任assignment。
              await tx.$executeRawUnsafe(
                `UPDATE fund_manager_assignments SET end_date = CURRENT_DATE, updated_at = NOW()
                 WHERE fund_id = $1 AND end_date IS NULL AND source <> $2`,
                fundId, SOURCE,
              );
              await tx.$executeRawUnsafe(`DELETE FROM fund_manager_assignments WHERE fund_id = $1 AND source = $2 AND end_date IS NULL`, fundId, SOURCE);
              await tx.$executeRawUnsafe(
                `INSERT INTO fund_manager_assignments (id, manager_id, fund_id, start_date, role, source, source_record_id, verified_at, created_at, updated_at)
                 VALUES (gen_random_uuid()::text, $1, $2, CURRENT_DATE, 'PM', $3, $4, NOW(), NOW(), NOW())`,
                managerId, fundId, SOURCE, repCode,
              );
            }
          });
        }
        groupsWritten++;
      }
      lastStem = stem;
      await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: lastStem, processed: groupsAttempted, succeeded: groupsWritten, failed: groupsFailed }, CHECKPOINT_BOUND);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failedDetail.push({ stem, error: message.slice(0, 300) });
      groupsFailed++;
      if (e instanceof FundclearBlockedError) {
        blocked = true;
        break; // 401/403/429或機器人驗證頁：整輪就停，不再嘗試下一組
      }
      // 其他錯誤（單一基金頁面逾時/解析失敗）：記錄、跳過，lastStem不更新，下次從這一組重試
    }

    if (index < stems.length - 1 && Date.now() < deadlineAt) {
      await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
    }
  }

  const reachedEnd = !blocked && index >= stems.length;
  if (reachedEnd) {
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: null, processed: groupsAttempted, succeeded: groupsWritten, failed: groupsFailed }, CHECKPOINT_BOUND);
  }

  await finishRun(runId, JOB, "FUNDCLEAR_ONSHORE", startedMs, {
    status: blocked ? "PARTIAL" : groupsFailed > 0 ? "PARTIAL" : "COMPLETED",
    attempted: groupsAttempted, completed: groupsWritten, inserted: groupsWritten, updated: 0, failed: groupsFailed,
    retryableFailures: 0, checkpointAfter: { lastSymbol: lastStem, processed: groupsAttempted, succeeded: groupsWritten, failed: groupsFailed, updatedAt: null },
    error: failedDetail.length ? `${failedDetail.length} failures; e.g. ${failedDetail[0]?.error}` : null,
    details: { write_enabled: writeEnabled, startIndex: Math.max(startIndex, 0), totalGroups: stems.length, groupsWritten, blocked, reachedEnd },
  }, CHECKPOINT_BOUND);

  return { ok: !blocked, skipped: false, groupsAttempted, groupsWritten, groupsFailed, blocked, failedDetail, reachedEnd, sampleResults };
}
