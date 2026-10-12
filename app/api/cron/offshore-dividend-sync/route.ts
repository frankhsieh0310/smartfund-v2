// Offshore (tdcc-offshore) fund distribution sync, sourced from 基金資訊觀測站 (fundclear.com.tw,
// operated by TDCC/投信投顧公會/期貨公會). No robots.txt (confirmed 404), no ToS clause prohibiting
// automated access or commercial use found (only page found is a personal-data privacy policy).
//
// Writes to the EXISTING fund_distribution_observations table -- every column needed already exists
// (ex_date, record_date, pay_date, distribution_amount, distribution_currency, income_component,
// return_of_capital, source); no DDL, no new table. SHADOW MODE BY DEFAULT: unless
// OFFSHORE_DIVIDEND_SYNC_WRITE is exactly "on", this route fetches and classifies but writes nothing.
//
// INCIDENT 2026-10-12 12:08 UTC: the original version accumulated every candidate and wrote them all
// in one pass at the very end, one row per round-trip. That run hit Vercel's 300s maxDuration after
// only 51/~330 candidates were written (confirmed via `vercel logs`: "Task timed out after 300
// seconds"). Fixed two ways: (1) writer.ts now does one multi-row INSERT per chunk instead of one
// round-trip per row; (2) this route flushes a chunk to the DB as soon as it fills, instead of only at
// the very end, so a run that gets cut off still keeps whatever it already wrote. TIME_BUDGET_MS
// dropped from 240s to 150s so flush+wrap-up time can never again be squeezed against the 300s wall.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { loadDailyProgress, saveDailyProgress } from "@/lib/offshore-dividend-sync/completion";
import { fetchOffshoreDistributions, RateLimitedError } from "@/lib/offshore-dividend-sync/fetchClear";
import { writeBatchIfEnabled, WRITE_CHUNK_SIZE, type QueryFn, type DistributionWriteCandidate } from "@/lib/offshore-dividend-sync/writer";
import { isWriteEnabled, currentRunMode } from "@/lib/offshore-dividend-sync/writeGate";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "OFFSHORE_DIVIDEND_SYNC";
const PROVIDER = "FUNDCLEAR_TDCC_OFFSHORE";
const TIME_BUDGET_MS = 150_000;
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

  const runKey = `offshore-dividend-sync:${new Date(startedMs).toISOString()}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: PROVIDER, runKey,
    universeCount: 0, batchSize: WRITE_CHUNK_SIZE, checkpointBefore: null,
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
  let fundsWithNewCandidates = 0;
  let totalWritten = 0, totalSkippedExisting = 0, totalWriteErrorCount = 0, totalCandidateCount = 0;
  let pendingBuffer: DistributionWriteCandidate[] = [];

  async function flush() {
    if (pendingBuffer.length === 0) return;
    const result = await writeBatchIfEnabled(query, pendingBuffer, writeEnabledThisRun);
    totalWritten += result.written;
    totalSkippedExisting += result.skippedExisting;
    totalWriteErrorCount += result.writeErrorCount;
    pendingBuffer = [];
    // Persist progress as we go too, so a cut-off run doesn't lose today's attempted-set either.
    if (writeEnabledThisRun) {
      const merged = new Set([...attemptedToday, ...newlyAttempted]);
      await saveDailyProgress(query, today, merged);
    }
  }

  for (const f of pending) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    attempted++;
    try {
      const result = await fetchOffshoreDistributions(f.code, startDate, endDate);
      if (writeEnabledThisRun) newlyAttempted.add(f.id);
      if (!result || result.records.length === 0) { noDistributionCount++; await sleep(REQUEST_SPACING_MS); continue; }
      let any = false;
      for (const record of result.records) {
        pendingBuffer.push({ fundId: f.id, currency: result.currency, record });
        totalCandidateCount++;
        any = true;
      }
      if (any) fundsWithNewCandidates++;
      if (pendingBuffer.length >= WRITE_CHUNK_SIZE) await flush();
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

  await flush(); // final partial chunk

  const status = "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status, attempted, completed: totalWritten, inserted: totalWritten, updated: 0,
    failed: errorCount + totalWriteErrorCount, retryableFailures: rateLimited ? pending.length - attempted : 0,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), universe_count: candidateFunds.length, pending_before_run: pending.length,
      attempted, no_distribution_count: noDistributionCount, error_count: errorCount,
      rate_limited: rateLimited, http_status: httpStatus,
      funds_with_candidates: fundsWithNewCandidates, candidate_record_count: totalCandidateCount,
      written: totalWritten, skipped_existing: totalSkippedExisting, write_error_count: totalWriteErrorCount,
      attempted_today_total: new Set([...attemptedToday, ...newlyAttempted]).size,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    universeCount: candidateFunds.length, pendingBeforeRun: pending.length, attempted,
    noDistributionCount, errorCount, rateLimited, httpStatus,
    fundsWithCandidates: fundsWithNewCandidates, candidateRecordCount: totalCandidateCount,
    written: totalWritten, skippedExisting: totalSkippedExisting, writeErrorCount: totalWriteErrorCount,
  });
}
