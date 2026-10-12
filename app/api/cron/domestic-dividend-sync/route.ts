// Domestic fund distribution sync, sourced from 投信投顧公會 (SITCA) 「基金配息資料」
// (IN2213.aspx), same official source already used by sitca-nav-sync. One request per month covers
// the WHOLE market ("所有公司"), no per-company iteration needed.
//
// Writes to the EXISTING fund_distribution_observations table (no DDL). SHADOW MODE BY DEFAULT:
// unless DOMESTIC_DIVIDEND_SYNC_WRITE is exactly "on", this route fetches/matches/classifies but
// writes nothing, and (same convention as offshore-nav-sync/offshore-dividend-sync, fixed earlier
// this session) a shadow-mode run never marks a month complete, so it can never block a later
// write-mode run from actually persisting it.
//
// Completion is DB-truth via a completed-months checkpoint: the first run backfills every month
// SITCA's own dropdown currently offers (2022/06 onward, discovered live, never hardcoded), and once
// caught up only the newest month is ever missing. Matching is code-first/name-fallback, identical
// convention to sitca-nav-sync. A row is only written if SITCA's 配息幣別 matches funds.currency
// exactly -- a mismatch is skipped and counted, never guessed at or written anyway.
//
// Writes flush per month (not once at the very end) and in multi-row chunks (writer.ts), same fix
// applied here as the offshore-dividend-sync 2026-10-12 timeout incident: a cut-off run keeps whatever
// months it already matched and wrote instead of losing everything buffered in memory. If the
// ~50-month backfill can't finish in one invocation, the completed-months checkpoint picks up exactly
// where it left off on the next trigger -- no special-cased "resume" logic needed.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { fetchAvailableMonths, fetchSitcaDividendsForMonth, RateLimitedError } from "@/lib/domestic-dividend-sync/sitcaDividendFetch";
import { matchDividendRows } from "@/lib/domestic-dividend-sync/matching";
import { loadCompletedMonths, saveCompletedMonths } from "@/lib/domestic-dividend-sync/completion";
import { writeBatchIfEnabled, type QueryFn } from "@/lib/domestic-dividend-sync/writer";
import { isWriteEnabled, currentRunMode } from "@/lib/domestic-dividend-sync/writeGate";
import type { FundRow } from "@/lib/domestic-dividend-sync/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "DOMESTIC_DIVIDEND_SYNC";
const PROVIDER = "SITCA_FSC_OFFICIAL_MONTHLY";
const TIME_BUDGET_MS = 150_000;
const REQUEST_SPACING_MS = 1_100;
const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabledThisRun = isWriteEnabled();

  const runKey = `domestic-dividend-sync:${new Date(startedMs).toISOString()}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: PROVIDER, runKey,
    universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present and running", runKey, runMode: currentRunMode() });
  }

  const availableMonths = await fetchAvailableMonths();
  const completedMonths = await loadCompletedMonths(query);
  // One-off recheck escape hatch (e.g. months a prior run skipped due to a transient fetch timeout, or
  // a month the currency fix at 2026-10-12 now has new eligible candidates for): listed months are
  // re-fetched and re-matched even though completedMonths already has them, but writer.ts's existing
  // per-row dedup still means only genuinely missing rows get written -- nothing already in
  // fund_distribution_observations is touched or re-inserted. Remove the env var once done; it has no
  // effect on the normal pending-months flow when unset.
  const recheckMonths = (process.env.DOMESTIC_DIVIDEND_SYNC_RECHECK_MONTHS ?? "")
    .split(",").map((m) => m.trim()).filter((m) => /^\d{6}$/.test(m));
  const pendingMonths = [...new Set([
    ...availableMonths.filter((m) => !completedMonths.has(m)),
    ...recheckMonths,
  ])].sort();

  const funds = await prisma.$queryRawUnsafe<FundRow[]>(
    `SELECT id, code, name, currency FROM funds WHERE COALESCE(data_provider, '') NOT IN ('yahoo', 'SEC')`,
  );

  let monthsAttempted = 0;
  let monthsCompleted = 0;
  let rowsFetched = 0;
  let unmatchedCount = 0;
  let currencyMismatchCount = 0;
  let errorCount = 0;
  let rateLimited = false;
  let httpStatus: number | null = null;
  let totalCandidateCount = 0;
  let totalWritten = 0, totalSkippedExisting = 0, totalWriteErrorCount = 0;
  const newlyCompleted = new Set<string>();

  for (const month of pendingMonths) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    monthsAttempted++;
    try {
      const rows = await fetchSitcaDividendsForMonth(month);
      rowsFetched += rows.length;
      const { matched, unmatched } = matchDividendRows(rows, funds);
      unmatchedCount += unmatched.length;
      const monthCandidates = [];
      for (const m of matched) {
        if (m.sitcaCurrency !== m.fundCurrency) { currencyMismatchCount++; continue; }
        monthCandidates.push(m);
      }
      totalCandidateCount += monthCandidates.length;

      const writeResult = await writeBatchIfEnabled(query, monthCandidates, writeEnabledThisRun);
      totalWritten += writeResult.written;
      totalSkippedExisting += writeResult.skippedExisting;
      totalWriteErrorCount += writeResult.writeErrorCount;

      monthsCompleted++;
      if (writeEnabledThisRun) {
        newlyCompleted.add(month);
        // Persist as each month finishes, not only at the very end -- a cut-off run keeps every month
        // it actually completed instead of losing that progress along with the in-memory buffer.
        await saveCompletedMonths(query, new Set([...completedMonths, ...newlyCompleted]));
      }
    } catch (e) {
      if (e instanceof RateLimitedError) {
        rateLimited = true;
        httpStatus = e.httpStatus;
        break;
      }
      errorCount++;
    }
    await sleep(REQUEST_SPACING_MS);
  }

  const status = "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status, attempted: monthsAttempted, completed: monthsCompleted, inserted: totalWritten, updated: 0,
    failed: errorCount + totalWriteErrorCount, retryableFailures: rateLimited ? pendingMonths.length - monthsAttempted : 0,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), available_months: availableMonths.length, pending_months_before_run: pendingMonths.length,
      recheck_months: recheckMonths,
      months_attempted: monthsAttempted, months_completed: monthsCompleted, rows_fetched: rowsFetched,
      unmatched_count: unmatchedCount, currency_mismatch_count: currencyMismatchCount, error_count: errorCount,
      rate_limited: rateLimited, http_status: httpStatus,
      candidate_record_count: totalCandidateCount, written: totalWritten,
      skipped_existing: totalSkippedExisting, write_error_count: totalWriteErrorCount,
      completed_months_total: writeEnabledThisRun ? completedMonths.size + newlyCompleted.size : completedMonths.size,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    availableMonths: availableMonths.length, pendingMonthsBeforeRun: pendingMonths.length,
    monthsAttempted, monthsCompleted, rowsFetched, unmatchedCount, currencyMismatchCount, errorCount,
    rateLimited, httpStatus, candidateRecordCount: totalCandidateCount,
    written: totalWritten, skippedExisting: totalSkippedExisting, writeErrorCount: totalWriteErrorCount,
  });
}
