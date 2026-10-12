// Offshore (tdcc-offshore) fund distribution sync, sourced from 基金資訊觀測站 (fundclear.com.tw,
// operated by TDCC/投信投顧公會/期貨公會). No robots.txt (confirmed 404), no ToS clause prohibiting
// automated access or commercial use found (only page found is a personal-data privacy policy).
//
// Writes to the EXISTING fund_distribution_observations table -- every column needed already exists
// (ex_date, record_date, pay_date, distribution_amount, distribution_currency, income_component,
// return_of_capital, source); no DDL, no new table. SHADOW MODE BY DEFAULT: unless
// OFFSHORE_DIVIDEND_SYNC_WRITE is exactly "on", this route fetches and classifies but writes nothing.
//
// One daily window (unlike offshore-nav-sync's 13 ticks/day): a 240s wall-clock budget per invocation,
// >=1.1s spacing between funds. Completion is a same-day "already attempted" set (its own checkpoint
// key, same convention as offshore-nav-sync's now-fixed write-mode-gated version). Dedup against
// double-writing the same distribution event is enforced in the writer (no unique constraint exists,
// so it's a SELECT-before-INSERT on (fund_id, ex_date, source)).
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { loadDailyProgress, saveDailyProgress } from "@/lib/offshore-dividend-sync/completion";
import { fetchOffshoreDistributions, RateLimitedError } from "@/lib/offshore-dividend-sync/fetchClear";
import { writeBatchIfEnabled, type QueryFn, type DistributionWriteCandidate } from "@/lib/offshore-dividend-sync/writer";
import { isWriteEnabled, currentRunMode } from "@/lib/offshore-dividend-sync/writeGate";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "OFFSHORE_DIVIDEND_SYNC";
const PROVIDER = "FUNDCLEAR_TDCC_OFFSHORE";
const TIME_BUDGET_MS = 240_000;
const REQUEST_SPACING_MS = 1_100;
const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function yearMonthRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1); // trailing 12 months
  const fmt = (d: Date) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  return { startDate: fmt(start), endDate: fmt(now) };
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabledThisRun = isWriteEnabled();
  const today = new Date().toISOString().slice(0, 10);
  const { startDate, endDate } = yearMonthRange();

  // Unique per invocation (not time-bucketed) -- learned from offshore-nav-sync's hour-bucket bug
  // earlier this session: a shared bucket key silently discards every run's audit detail but the
  // last one within that bucket, even though the real writes all happened.
  const runKey = `offshore-dividend-sync:${new Date(startedMs).toISOString()}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: PROVIDER, runKey,
    universeCount: 0, batchSize: 200, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present and running", runKey, runMode: currentRunMode() });
  }

  const candidateFunds = await prisma.$queryRawUnsafe<Array<{ id: string; code: string }>>(
    `SELECT id, code FROM funds WHERE data_provider = 'tdcc-offshore' AND is_active = true`,
  );

  const attemptedToday = await loadDailyProgress(query, today);
  const pending = candidateFunds.filter((f) => !attemptedToday.has(f.id));

  let attempted = 0;
  let noDistributionCount = 0;
  let errorCount = 0;
  let rateLimited = false;
  let httpStatus: number | null = null;
  const newlyAttempted = new Set<string>();
  const candidates: DistributionWriteCandidate[] = [];
  let fundsWithNewCandidates = 0;

  for (const f of pending) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    attempted++;
    try {
      const result = await fetchOffshoreDistributions(f.code, startDate, endDate);
      if (writeEnabledThisRun) newlyAttempted.add(f.id);
      if (!result || result.records.length === 0) { noDistributionCount++; await sleep(REQUEST_SPACING_MS); continue; }
      let any = false;
      for (const record of result.records) {
        candidates.push({ fundId: f.id, currency: result.currency, record });
        any = true;
      }
      if (any) fundsWithNewCandidates++;
    } catch (e) {
      if (e instanceof RateLimitedError) {
        rateLimited = true;
        httpStatus = e.httpStatus;
        break; // stop immediately on 403/429, do not sleep further
      }
      errorCount++;
      if (writeEnabledThisRun) newlyAttempted.add(f.id);
    }
    await sleep(REQUEST_SPACING_MS);
  }

  const writeResult = await writeBatchIfEnabled(query, candidates, writeEnabledThisRun);

  const mergedAttempted = new Set([...attemptedToday, ...newlyAttempted]);
  if (writeEnabledThisRun) {
    await saveDailyProgress(query, today, mergedAttempted);
  }

  const status = "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status, attempted, completed: writeResult.written, inserted: writeResult.written, updated: 0,
    failed: errorCount + writeResult.writeErrorCount, retryableFailures: rateLimited ? pending.length - attempted : 0,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), universe_count: candidateFunds.length, pending_before_run: pending.length,
      attempted, no_distribution_count: noDistributionCount, error_count: errorCount,
      rate_limited: rateLimited, http_status: httpStatus,
      funds_with_candidates: fundsWithNewCandidates, candidate_record_count: candidates.length,
      written: writeResult.written, skipped_existing: writeResult.skippedExisting, write_error_count: writeResult.writeErrorCount,
      attempted_today_total: mergedAttempted.size,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    universeCount: candidateFunds.length, pendingBeforeRun: pending.length, attempted,
    noDistributionCount, errorCount, rateLimited, httpStatus,
    fundsWithCandidates: fundsWithNewCandidates, candidateRecordCount: candidates.length,
    written: writeResult.written, skippedExisting: writeResult.skippedExisting, writeErrorCount: writeResult.writeErrorCount,
  });
}
