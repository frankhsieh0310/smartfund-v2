import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { fetchFundclearTwHolding, FundclearOffshoreRateLimitedError } from "./fundclearTwHolding";
import { isOffshoreTwHoldingWriteEnabled } from "./twHoldingWriteGate";

const JOB = "OFFSHORE_TW_HOLDING_SYNC";
const CHECKPOINT_KEY = "offshore-tw-holding-sync:cursor";
const REQUEST_DELAY_MS = 2_000;
const TIME_BUDGET_MS = 30_000;
const BATCH_SIZE = Math.ceil(TIME_BUDGET_MS / REQUEST_DELAY_MS);

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= 60 && taipeiMinutes < 330;
}

type Candidate = { fundId: string; isin: string };

async function nextCandidates(afterId: string | null, limit: number): Promise<Candidate[]> {
  return prisma.$queryRawUnsafe<Candidate[]>(
    `SELECT f.id AS "fundId", f.isin AS isin
       FROM funds f
       JOIN tw_purchasable_classification c ON c.asset_type = 'FUND' AND c.asset_id = f.id AND c.status = 'APPROVED'
      WHERE f.isin IS NOT NULL
        AND f.id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
        AND ($1::text IS NULL OR f.id > $1)
      ORDER BY f.id
      LIMIT $2`,
    afterId,
    limit,
  );
}

export type OffshoreTwHoldingResult = { ok: boolean; skipped: boolean; reason?: string; attempted?: number; written?: number; rateLimitStop?: boolean };

export async function runOffshoreTwHoldingSync(): Promise<OffshoreTwHoldingResult> {
  const now = new Date();
  if (isWithinForbiddenTaipeiWindow(now)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" };
  }
  const writeEnabled = isOffshoreTwHoldingWriteEnabled();
  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  const afterId = checkpoint?.lastSymbol ?? null;
  let candidates = await nextCandidates(afterId, BATCH_SIZE);
  let wrapped = false;
  if (candidates.length === 0 && afterId !== null) {
    candidates = await nextCandidates(null, BATCH_SIZE);
    wrapped = true;
  }
  if (candidates.length === 0) return { ok: true, skipped: true, reason: "no APPROVED offshore funds with ISIN found" };

  const runKey = `offshore-tw-holding-sync:${now.toISOString().slice(0, 13)}:${afterId ?? "start"}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "FUNDCLEAR_QUERY_FUND_REPORT", runKey, universeCount: 0, batchSize: candidates.length, checkpointBefore: checkpoint });
  if (skipped) return { ok: true, skipped: true, reason: "already attempted this hour" };

  const startedMs = Date.now();
  let attempted = 0, written = 0, lastId: string | null = afterId, rateLimitStop = false;
  try {
    for (const cand of candidates) {
      if (Date.now() - startedMs > TIME_BUDGET_MS) break;
      attempted++;
      try {
        const holding = await fetchFundclearTwHolding(cand.isin);
        if (holding && writeEnabled) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO fund_offshore_tw_holding_fundclear (fund_id, tw_holding_twd, tw_holding_pct, year_month, source, fetched_at)
             VALUES ($1, $2, $3, $4, 'FUNDCLEAR_QUERY_FUND_REPORT', now())
             ON CONFLICT (fund_id) DO UPDATE SET
               tw_holding_twd = EXCLUDED.tw_holding_twd, tw_holding_pct = EXCLUDED.tw_holding_pct,
               year_month = EXCLUDED.year_month, fetched_at = now()`,
            cand.fundId, holding.twHoldingTwd, holding.twHoldingPct, holding.yearMonth,
          );
          written++;
        } else if (holding) {
          written++; // shadow-mode count
        }
      } catch (e) {
        if (e instanceof FundclearOffshoreRateLimitedError) { rateLimitStop = true; break; }
      }
      lastId = cand.fundId;
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }

    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
      lastSymbol: wrapped && attempted === 0 ? null : lastId,
      processed: attempted, succeeded: written, failed: attempted - written,
    });
    await finishRun(runId, JOB, "FUNDCLEAR_QUERY_FUND_REPORT", startedMs, {
      status: rateLimitStop ? "PARTIAL" : "COMPLETED", attempted, completed: written, inserted: writeEnabled ? written : 0, updated: 0,
      failed: attempted - written, retryableFailures: rateLimitStop ? 1 : 0, checkpointAfter: null,
      details: { writeEnabled, rateLimitStop, wrapped, lastId },
    });
    return { ok: true, skipped: false, attempted, written, rateLimitStop };
  } catch (e: any) {
    await finishRun(runId, JOB, "FUNDCLEAR_QUERY_FUND_REPORT", startedMs, {
      status: "FAILED", attempted, completed: written, inserted: 0, updated: 0, failed: attempted - written,
      retryableFailures: 0, error: String(e?.message ?? e), checkpointAfter: null,
    });
    return { ok: false, skipped: false, reason: String(e?.message ?? e) };
  }
}
