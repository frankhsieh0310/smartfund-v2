// 投信官網月報持股 — 寫入開關、checkpoint、排程規則（2026-11-03使用者核准）。
//
// 新鮮度判斷延續CLAUDE.md一貫原則：不猜「今天是不是第10個營業日」，改用「官網自己回報的
// 資料月份」跟我們資料庫目前這檔基金ISSUER_OFFICIAL_MONTHLY來源的最新月份比較——官網還沒公布
// 新一個月的資料時，fetch回來的dataMonth跟我們已有的一樣，直接跳過寫入（視同「官網還沒更新，
// 不算異常」）；一旦官網真的更新了，下次排程自然抓到新月份並寫入。cheap pre-check（看DB）能
// 避免「官網還沒更新」時也浪費一次Puppeteer渲染。
//
// 429/403：IssuerSiteBlockedError整個issuer這次呼叫就停（不再嘗試下一檔），checkpoint停在最後
// 一個成功的位置，下次排程從原地重試被擋的那一檔。
//
// 01:00-05:30台北不執行：沿用lib/sitca-nav-sync/monthlyDisclosureWriter.ts同一套算法。
//
// 多級別基金：同一個sourceId對應的fundIds（見issuerFundMappings.ts）全部一起寫入同一份持股
// （基金層級資料、所有share class共用）。
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint, type CheckpointRow, type BoundedDbOptions } from "@/lib/cloud-ingestion/runContext";
import {
  fetchYuantaMonthlyHoldings, fetchCathayMonthlyHoldings, fetchNomuraMonthlyHoldings,
  IssuerSiteBlockedError, type IssuerMonthlyHoldingsResult,
} from "@/lib/cloud-ingestion/issuerMonthlyHoldings";
import { YUANTA_FUND_MAPPINGS, CATHAY_FUND_MAPPINGS, NOMURA_FUND_MAPPINGS, type IssuerFundMapping } from "@/lib/cloud-ingestion/issuerFundMappings";

export type SupportedIssuer = "Yuanta" | "Cathay" | "Nomura";

export function isIssuerMonthlyHoldingsWriteEnabled(): boolean {
  return process.env.ISSUER_MONTHLY_HOLDINGS_WRITE?.trim() === "on";
}

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= 60 && taipeiMinutes < 330; // 01:00-05:30
}

function sourceNameFor(issuer: SupportedIssuer): string {
  return `${issuer.toUpperCase()}_OFFICIAL_MONTHLY`;
}

function mappingsFor(issuer: SupportedIssuer): IssuerFundMapping[] {
  if (issuer === "Yuanta") return YUANTA_FUND_MAPPINGS;
  if (issuer === "Cathay") return CATHAY_FUND_MAPPINGS;
  return NOMURA_FUND_MAPPINGS;
}

async function fetchHoldings(issuer: SupportedIssuer, sourceId: string): Promise<IssuerMonthlyHoldingsResult> {
  if (issuer === "Yuanta") return fetchYuantaMonthlyHoldings(sourceId);
  if (issuer === "Cathay") return fetchCathayMonthlyHoldings(sourceId);
  const [groupId, gradeId] = sourceId.split("::");
  return fetchNomuraMonthlyHoldings(groupId, gradeId);
}

function lastDayOfMonth(dataMonth: string): string {
  // dataMonth是"YYYY/MM"，照既有holdings表的慣例（VERIFIED MONEYDJ_PUBLIC_DISCLOSURE現有資料
  // 用as_of_date=該月最後一天，例如"2026-09-30"），不是自己發明新格式。
  const [y, m] = dataMonth.split("/").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

const CHECKPOINT_BOUND: BoundedDbOptions = { maxWaitMs: 5_000, statementTimeoutMs: 10_000, timeoutMs: 15_000 };
const REQUEST_SPACING_MS = 2_500; // 請求之間的間隔

function todayTaipeiKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function taipeiDateKey(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type IssuerMonthlyHoldingsRunResult = {
  ok: boolean;
  issuer: SupportedIssuer;
  skipped: boolean;
  reason?: string;
  universeCount: number;
  processed: number;
  alreadyCurrent: number;
  written: number;
  failed: number;
  blocked: boolean;
  failedDetail: Array<{ sourceId: string; error: string }>;
  reachedEnd: boolean;
};

export async function runIssuerMonthlyHoldings(
  issuer: SupportedIssuer,
  deadlineAt: number,
): Promise<IssuerMonthlyHoldingsRunResult> {
  const now = new Date();
  if (isWithinForbiddenTaipeiWindow(now)) {
    return {
      ok: true, issuer, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)",
      universeCount: 0, processed: 0, alreadyCurrent: 0, written: 0, failed: 0, blocked: false, failedDetail: [], reachedEnd: false,
    };
  }
  const mappings = mappingsFor(issuer);
  if (mappings.length === 0) {
    return {
      ok: true, issuer, skipped: true, reason: "NO_FUND_MAPPING_YET",
      universeCount: 0, processed: 0, alreadyCurrent: 0, written: 0, failed: 0, blocked: false, failedDetail: [], reachedEnd: false,
    };
  }

  const writeEnabled = isIssuerMonthlyHoldingsWriteEnabled();
  const source = sourceNameFor(issuer);
  const JOB = `ISSUER_MONTHLY_HOLDINGS:${issuer}`;
  const checkpointKey = `issuer-monthly-holdings:${issuer.toLowerCase()}`;

  const storedCheckpoint = await readCheckpoint(checkpointKey, CHECKPOINT_BOUND);
  const isFromToday = taipeiDateKey(storedCheckpoint?.updatedAt ?? null) === todayTaipeiKey();
  const effectiveCheckpoint: CheckpointRow | null = isFromToday ? storedCheckpoint : null;
  const startIndex = effectiveCheckpoint?.lastSymbol
    ? mappings.findIndex((m) => m.sourceId === effectiveCheckpoint.lastSymbol) + 1
    : 0;

  const runKey = `${JOB}:${todayTaipeiKey()}:starting-at-${Math.max(startIndex, 0)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: issuer, runKey, universeCount: mappings.length,
    batchSize: mappings.length - Math.max(startIndex, 0), checkpointBefore: effectiveCheckpoint,
  }, CHECKPOINT_BOUND);
  if (skipped) {
    return {
      ok: true, issuer, skipped: true, reason: "run_key already present (double trigger)",
      universeCount: mappings.length, processed: 0, alreadyCurrent: 0, written: 0, failed: 0, blocked: false, failedDetail: [], reachedEnd: false,
    };
  }

  const startedMs = Date.now();
  let processed = 0, alreadyCurrent = 0, written = 0, failedCount = 0;
  let blocked = false;
  const failedDetail: Array<{ sourceId: string; error: string }> = [];
  let lastSuccessSourceId: string | null = effectiveCheckpoint?.lastSymbol ?? null;
  let index = Math.max(startIndex, 0);

  for (; index < mappings.length; index++) {
    if (Date.now() >= deadlineAt) break;
    const m = mappings[index];
    processed++;

    // Cheap pre-check: skip the fetch entirely if we already have THIS calendar month's data for
    // this source on the representative fund (fund-level data, so checking one member fund id
    // suffices — all share classes of the same group are always written together).
    const repFundId = m.fundIds[0];
    const existing = await prisma.$queryRawUnsafe<{ as_of_date: string }[]>(
      `SELECT as_of_date::text FROM holdings WHERE fund_id = $1 AND source = $2 ORDER BY as_of_date DESC LIMIT 1`,
      repFundId, source,
    );
    const nowTaipei = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const currentYearMonth = `${nowTaipei.getUTCFullYear()}-${String(nowTaipei.getUTCMonth() + 1).padStart(2, "0")}`;
    if (existing[0]?.as_of_date?.startsWith(currentYearMonth)) {
      alreadyCurrent++;
      lastSuccessSourceId = m.sourceId;
      await writeCheckpoint(JOB, checkpointKey, runId, {
        lastSymbol: lastSuccessSourceId, processed, succeeded: alreadyCurrent + written, failed: failedCount,
      }, CHECKPOINT_BOUND);
      continue;
    }

    try {
      const result = await fetchHoldings(issuer, m.sourceId);
      const asOfDate = lastDayOfMonth(result.dataMonth);
      // 如果官網這次回來的月份其實跟DB裡已有的一樣新（例如上面pre-check剛好卡在月份邊界的race），
      // 一樣不寫入——避免重複寫一樣的月份。
      const alreadyHasThisMonth = existing[0]?.as_of_date === asOfDate;
      if (!alreadyHasThisMonth && writeEnabled) {
        await prisma.$transaction(async (tx) => {
          for (const fundId of m.fundIds) {
            await tx.$executeRawUnsafe(`DELETE FROM holdings WHERE fund_id = $1 AND source = $2`, fundId, source);
            for (let rank = 0; rank < result.holdings.length; rank++) {
              const h = result.holdings[rank];
              await tx.$executeRawUnsafe(
                `INSERT INTO holdings (fund_id, as_of_date, rank, holding_name, weight, source, asset_type, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, 'FUND', now())`,
                fundId, asOfDate, rank + 1, h.name, h.weight, source,
              );
            }
          }
        });
        written++;
      }
      lastSuccessSourceId = m.sourceId;
      await writeCheckpoint(JOB, checkpointKey, runId, {
        lastSymbol: lastSuccessSourceId, processed, succeeded: alreadyCurrent + written, failed: failedCount,
      }, CHECKPOINT_BOUND);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failedDetail.push({ sourceId: m.sourceId, error: message.slice(0, 300) });
      failedCount++;
      if (e instanceof IssuerSiteBlockedError) {
        blocked = true;
        break; // 429/403：整個這次呼叫就停，不再嘗試下一檔
      }
      // 其他錯誤（例如單一基金頁面格式解析失敗）：記錄、跳過這一檔，繼續下一檔——不讓一檔的
      // 問題擋住其他79/37檔的進度。lastSuccessSourceId刻意不更新，checkpoint停在上一個成功
      // 的位置之前，下次排程仍會重試這一檔。
    }

    if (index < mappings.length - 1 && Date.now() < deadlineAt) {
      await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
    }
  }

  const reachedEnd = !blocked && index >= mappings.length;
  if (reachedEnd) {
    await writeCheckpoint(JOB, checkpointKey, runId, {
      lastSymbol: null, processed, succeeded: alreadyCurrent + written, failed: failedCount,
    }, CHECKPOINT_BOUND);
  }

  await finishRun(runId, JOB, issuer, startedMs, {
    status: blocked ? "PARTIAL" : failedCount > 0 ? "PARTIAL" : "COMPLETED",
    attempted: processed, completed: alreadyCurrent + written, inserted: written, updated: 0, failed: failedCount,
    retryableFailures: 0, checkpointAfter: { lastSymbol: lastSuccessSourceId, processed, succeeded: alreadyCurrent + written, failed: failedCount, updatedAt: null },
    error: failedDetail.length ? `${failedDetail.length} failures; e.g. ${failedDetail[0]?.error}` : null,
    details: { issuer, write_enabled: writeEnabled, startIndex: Math.max(startIndex, 0), alreadyCurrent, written, blocked, reachedEnd },
  }, CHECKPOINT_BOUND);

  return {
    ok: !blocked, issuer, skipped: false, universeCount: mappings.length, processed, alreadyCurrent, written,
    failed: failedCount, blocked, failedDetail, reachedEnd,
  };
}
