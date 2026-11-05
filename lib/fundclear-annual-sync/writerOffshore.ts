// 境外基金年度費用率／報酬率 —— 獨立排程（2026-11-05使用者核准），不掛在既有sitca-nav-sync
// 或offshore-nav-tdcc-sync底下，自己的cron entry、自己的run log、自己的checkpoint。
// 寫入開關預設關閉（FUNDCLEAR_OFFSHORE_ANNUAL_WRITE），沿用既有fund_annual_metrics_fundclear表
// （不需要新建資料表/不需要DDL——跟境內版共用同一張表，用fund_id區分，境內/境外基金id本來就
// 不重疊，不會互相覆蓋）。一次一個請求、間隔至少3秒、20秒逾時、401/403/429立即停止整批。
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { fetchFundclearOffshoreAnnualRate, FundclearOffshoreRateLimitedError } from "./fetchOffshore";
import { isFundclearOffshoreAnnualWriteEnabled } from "./writeGateOffshore";

const JOB = "FUNDCLEAR_OFFSHORE_ANNUAL_RATE_SYNC";
const CHECKPOINT_KEY = "fundclear-offshore-annual-sync:cursor";
const REQUEST_DELAY_MS = 3_000; // 使用者明確要求：至少間隔3秒
const TIME_BUDGET_MS = 240_000;
const BATCH_SIZE = Math.ceil(TIME_BUDGET_MS / REQUEST_DELAY_MS);
const BLACKOUT_START_MIN = 60;
const BLACKOUT_END_MIN = 330;

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= BLACKOUT_START_MIN && taipeiMinutes < BLACKOUT_END_MIN;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Candidate = { fundId: string; code: string; latestStoredYear: string | null };

async function nextCandidates(afterId: string | null, limit: number): Promise<Candidate[]> {
  // 已有最新版本就不重抓：fund_annual_metrics_fundclear裡這檔基金目前最新一筆year，如果已經是
  // 「去年」（年度資料本來就要等隔年才會有完整一整年），就跳過，不用每次都重打fundclear。
  const thisYear = new Date().getUTCFullYear();
  const latestExpectedYear = String(thisYear - 1);
  return prisma.$queryRawUnsafe<Candidate[]>(
    `SELECT f.id AS "fundId", f.code AS "code",
            (SELECT MAX(year) FROM fund_annual_metrics_fundclear m WHERE m.fund_id = f.id AND m.source = 'FUNDCLEAR_OFFSHORE_QUERY_RATE') AS "latestStoredYear"
       FROM funds f
       JOIN tw_purchasable_classification c ON c.asset_type = 'FUND' AND c.asset_id = f.id AND c.status = 'APPROVED'
      WHERE f.data_provider = 'tdcc-offshore' AND f.code IS NOT NULL
        AND ($1::text IS NULL OR f.id > $1)
        AND COALESCE((SELECT MAX(year) FROM fund_annual_metrics_fundclear m WHERE m.fund_id = f.id AND m.source = 'FUNDCLEAR_OFFSHORE_QUERY_RATE'), '0') < $2
      ORDER BY f.id
      LIMIT $3`,
    afterId, latestExpectedYear, limit,
  );
}

export type FundclearOffshoreAnnualResult = {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  attempted?: number;
  written?: number;
  noData?: number;
  rateLimitStop?: boolean;
};

export async function runFundclearOffshoreAnnualSync(): Promise<FundclearOffshoreAnnualResult> {
  const now = new Date();
  if (isWithinForbiddenTaipeiWindow(now)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" };
  }
  const writeEnabled = isFundclearOffshoreAnnualWriteEnabled();
  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  const afterId = checkpoint?.lastSymbol ?? null;
  let candidates = await nextCandidates(afterId, BATCH_SIZE);
  let wrapped = false;
  if (candidates.length === 0 && afterId !== null) {
    candidates = await nextCandidates(null, BATCH_SIZE);
    wrapped = true;
  }
  if (candidates.length === 0) return { ok: true, skipped: true, reason: "no pending offshore funds (all already have last year's data, or none approved with a code)" };

  const runKey = `fundclear-offshore-annual-sync:${now.toISOString().slice(0, 10)}:${afterId ?? "start"}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "FUNDCLEAR_OFFSHORE_QUERY_RATE", runKey, universeCount: 0, batchSize: candidates.length, checkpointBefore: checkpoint,
  });
  if (skipped) return { ok: true, skipped: true, reason: "already attempted today from this cursor position" };

  const startedMs = Date.now();
  let attempted = 0, written = 0, noData = 0;
  let lastId: string | null = afterId;
  let rateLimitStop = false;
  try {
    for (const cand of candidates) {
      if (Date.now() - startedMs > TIME_BUDGET_MS) break;
      attempted++;
      try {
        const rows = await fetchFundclearOffshoreAnnualRate(cand.code);
        if (rows.length === 0) { noData++; }
        else if (writeEnabled) {
          for (const row of rows) {
            if (row.returnPct === null && row.feeRatePct === null) continue;
            await prisma.$executeRawUnsafe(
              `INSERT INTO fund_annual_metrics_fundclear (fund_id, year, return_pct, fee_rate_pct, return_source, source, fetched_at)
               VALUES ($1, $2, $3, $4, $5, 'FUNDCLEAR_OFFSHORE_QUERY_RATE', now())
               ON CONFLICT (fund_id, year) DO UPDATE SET
                 return_pct = EXCLUDED.return_pct, fee_rate_pct = EXCLUDED.fee_rate_pct,
                 return_source = EXCLUDED.return_source, source = EXCLUDED.source, fetched_at = now()`,
              cand.fundId, row.year, row.returnPct, row.feeRatePct, row.returnSource,
            );
          }
          written++;
        } else {
          written++; // shadow-mode: 「如果有打開寫入開關會寫幾筆」的計數
        }
      } catch (e) {
        if (e instanceof FundclearOffshoreRateLimitedError) { rateLimitStop = true; break; }
        noData++;
      }
      lastId = cand.fundId;
      await sleep(REQUEST_DELAY_MS);
    }

    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
      lastSymbol: wrapped && attempted === 0 ? null : lastId,
      processed: attempted, succeeded: written, failed: noData,
    });

    const status = rateLimitStop ? "PARTIAL" : "COMPLETED";
    await finishRun(runId, JOB, "FUNDCLEAR_OFFSHORE_QUERY_RATE", startedMs, {
      status, attempted, completed: written, inserted: written, updated: 0, failed: noData, retryableFailures: rateLimitStop ? 1 : 0,
      checkpointAfter: null,
      details: { writeEnabled, rateLimitStop, wrapped, lastId },
    });
    return { ok: true, skipped: false, attempted, written, noData, rateLimitStop };
  } catch (e: any) {
    await finishRun(runId, JOB, "FUNDCLEAR_OFFSHORE_QUERY_RATE", startedMs, {
      status: "FAILED", attempted, completed: written, inserted: written, updated: 0, failed: noData,
      retryableFailures: 0, error: String(e?.message ?? e), checkpointAfter: null,
      details: { writeEnabled },
    });
    return { ok: false, skipped: false, reason: String(e?.message ?? e) };
  }
}
