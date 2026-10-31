import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { fetchFundclearAnnualRate, FundclearRateLimitedError } from "./fetch";
import { isFundclearAnnualWriteEnabled } from "./writeGate";

const JOB = "FUNDCLEAR_ANNUAL_RATE_SYNC";
const CHECKPOINT_KEY = "fundclear-annual-sync:cursor";
const REQUEST_DELAY_MS = 2_500;
const TIME_BUDGET_MS = 25_000; // small fixed slice appended to the existing sitca-nav-sync cron, same pattern as the mapping backfill slice in fund-returns-sync
const BATCH_SIZE = Math.ceil(TIME_BUDGET_MS / REQUEST_DELAY_MS);
// 台北 01:00-05:30 不執行（跟其他會打外部站點的排程同一慣例）
const BLACKOUT_START_MIN = 60;
const BLACKOUT_END_MIN = 330;

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= BLACKOUT_START_MIN && taipeiMinutes < BLACKOUT_END_MIN;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Candidate = { fundId: string; code: string };

async function nextCandidates(afterId: string | null, limit: number): Promise<Candidate[]> {
  // 只處理「只有一個級別」的 APPROVED 境內基金——FundClear query-rate 用基金代碼查，分不出級別，
  // 多級別基金套用這份資料會把同一份年度數字誤標成每個級別各自的數字，不准這樣做。
  // 「只有一個級別」= code 是純 8 位數字（沒有級別字尾），且沒有任何 code+字母 的級別存在。
  return prisma.$queryRawUnsafe<Candidate[]>(
    `SELECT f.id AS "fundId", f.code AS "code"
       FROM funds f
       JOIN tw_purchasable_classification c ON c.asset_type = 'FUND' AND c.asset_id = f.id AND c.status = 'APPROVED'
      WHERE f.code ~ '^[0-9]{8}$'
        AND f.id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
        AND NOT EXISTS (SELECT 1 FROM funds f2 WHERE f2.code = f.code || 'A')
        AND ($1::text IS NULL OR f.id > $1)
      ORDER BY f.id
      LIMIT $2`,
    afterId,
    limit,
  );
}

export type FundclearAnnualResult = {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  attempted?: number;
  written?: number;
  noData?: number;
  rateLimitStop?: boolean;
};

export async function runFundclearAnnualSync(): Promise<FundclearAnnualResult> {
  const now = new Date();
  if (isWithinForbiddenTaipeiWindow(now)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" };
  }
  const writeEnabled = isFundclearAnnualWriteEnabled();
  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  const afterId = checkpoint?.lastSymbol ?? null;
  let candidates = await nextCandidates(afterId, BATCH_SIZE);
  let wrapped = false;
  if (candidates.length === 0 && afterId !== null) {
    candidates = await nextCandidates(null, BATCH_SIZE);
    wrapped = true;
  }
  if (candidates.length === 0) return { ok: true, skipped: true, reason: "no single-share-class domestic funds found" };

  const runKey = `fundclear-annual-sync:${now.toISOString().slice(0, 13)}:${afterId ?? "start"}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "FUNDCLEAR_QUERY_RATE", runKey, universeCount: 0, batchSize: candidates.length, checkpointBefore: checkpoint,
  });
  if (skipped) return { ok: true, skipped: true, reason: "already attempted this hour" };

  const startedMs = Date.now();
  let attempted = 0, written = 0, noData = 0;
  let lastId: string | null = afterId;
  let rateLimitStop = false;
  try {
    for (const cand of candidates) {
      if (Date.now() - startedMs > TIME_BUDGET_MS) break;
      attempted++;
      try {
        const rows = await fetchFundclearAnnualRate(cand.code);
        if (rows.length === 0) { noData++; }
        else if (writeEnabled) {
          for (const row of rows) {
            if (row.returnPct === null && row.feeRatePct === null) continue;
            await prisma.$executeRawUnsafe(
              `INSERT INTO fund_annual_metrics_fundclear (fund_id, year, return_pct, fee_rate_pct, return_source, source, fetched_at)
               VALUES ($1, $2, $3, $4, $5, 'FUNDCLEAR_QUERY_RATE', now())
               ON CONFLICT (fund_id, year) DO UPDATE SET
                 return_pct = EXCLUDED.return_pct, fee_rate_pct = EXCLUDED.fee_rate_pct,
                 return_source = EXCLUDED.return_source, fetched_at = now()`,
              cand.fundId, row.year, row.returnPct, row.feeRatePct, row.returnSource,
            );
          }
          written++;
        } else {
          written++; // shadow-mode count of "would have written"
        }
      } catch (e) {
        if (e instanceof FundclearRateLimitedError) { rateLimitStop = true; break; }
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
    await finishRun(runId, JOB, "FUNDCLEAR_QUERY_RATE", startedMs, {
      status, attempted, completed: written, inserted: written, updated: 0, failed: noData, retryableFailures: rateLimitStop ? 1 : 0,
      checkpointAfter: null,
      details: { writeEnabled, rateLimitStop, wrapped, lastId },
    });
    return { ok: true, skipped: false, attempted, written, noData, rateLimitStop };
  } catch (e: any) {
    await finishRun(runId, JOB, "FUNDCLEAR_QUERY_RATE", startedMs, {
      status: "FAILED", attempted, completed: written, inserted: written, updated: 0, failed: noData,
      retryableFailures: 0, error: String(e?.message ?? e), checkpointAfter: null,
      details: { writeEnabled },
    });
    return { ok: false, skipped: false, reason: String(e?.message ?? e) };
  }
}
