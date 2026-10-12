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
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { fetchAvailableMonths, fetchSitcaDividendsForMonth, RateLimitedError } from "@/lib/domestic-dividend-sync/sitcaDividendFetch";
import { matchDividendRows } from "@/lib/domestic-dividend-sync/matching";
import { loadCompletedMonths, saveCompletedMonths } from "@/lib/domestic-dividend-sync/completion";
import { writeBatchIfEnabled, type QueryFn } from "@/lib/domestic-dividend-sync/writer";
import { isWriteEnabled, currentRunMode } from "@/lib/domestic-dividend-sync/writeGate";
import type { DividendMatchResult, FundRow } from "@/lib/domestic-dividend-sync/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "DOMESTIC_DIVIDEND_SYNC";
const PROVIDER = "SITCA_FSC_OFFICIAL_MONTHLY";
const TIME_BUDGET_MS = 240_000;
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
  const pendingMonths = availableMonths.filter((m) => !completedMonths.has(m)).sort();

  const funds = await prisma.$queryRawUnsafe<FundRow[]>(
    `SELECT id, code, name, currency FROM funds WHERE COALESCE(data_provider, '') NOT IN ('yahoo', 'SEC')`,
  );

  const allCandidates: DividendMatchResult[] = [];
  let monthsAttempted = 0;
  let monthsCompleted = 0;
  let rowsFetched = 0;
  let unmatchedCount = 0;
  let currencyMismatchCount = 0;
  let errorCount = 0;
  let rateLimited = false;
  let httpStatus: number | null = null;
  const newlyCompleted = new Set<string>();

  for (const month of pendingMonths) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    monthsAttempted++;
    try {
      const rows = await fetchSitcaDividendsForMonth(month);
      rowsFetched += rows.length;
      const { matched, unmatched } = matchDividendRows(rows, funds);
      unmatchedCount += unmatched.length;
      for (const m of matched) {
        if (m.sitcaCurrency !== m.fundCurrency) { currencyMismatchCount++; continue; }
        allCandidates.push(m);
      }
      monthsCompleted++;
      if (writeEnabledThisRun) newlyCompleted.add(month);
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

  const writeResult = await writeBatchIfEnabled(query, allCandidates, writeEnabledThisRun);

  if (writeEnabledThisRun && newlyCompleted.size > 0) {
    const merged = new Set([...completedMonths, ...newlyCompleted]);
    await saveCompletedMonths(query, merged);
  }

  const status = "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status, attempted: monthsAttempted, completed: monthsCompleted, inserted: writeResult.written, updated: 0,
    failed: errorCount + writeResult.writeErrorCount, retryableFailures: rateLimited ? pendingMonths.length - monthsAttempted : 0,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), available_months: availableMonths.length, pending_months_before_run: pendingMonths.length,
      months_attempted: monthsAttempted, months_completed: monthsCompleted, rows_fetched: rowsFetched,
      unmatched_count: unmatchedCount, currency_mismatch_count: currencyMismatchCount, error_count: errorCount,
      rate_limited: rateLimited, http_status: httpStatus,
      candidate_record_count: allCandidates.length, written: writeResult.written,
      skipped_existing: writeResult.skippedExisting, write_error_count: writeResult.writeErrorCount,
      completed_months_total: writeEnabledThisRun ? completedMonths.size + newlyCompleted.size : completedMonths.size,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    availableMonths: availableMonths.length, pendingMonthsBeforeRun: pendingMonths.length,
    monthsAttempted, monthsCompleted, rowsFetched, unmatchedCount, currencyMismatchCount, errorCount,
    rateLimited, httpStatus, candidateRecordCount: allCandidates.length,
    written: writeResult.written, skippedExisting: writeResult.skippedExisting, writeErrorCount: writeResult.writeErrorCount,
  });
}
