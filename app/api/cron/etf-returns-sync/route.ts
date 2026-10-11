// Task X: daily ETF return sync — writes ONLY Yahoo's own fundPerformance.trailingReturns numbers
// into etf_performances (1M/3M/YTD/1Y/3Y/5Y; 3Y/5Y are Yahoo's own ANNUALIZED figures, confirmed live
// this session against an independently-computed CAGR). Never computes a return itself.
//
// Column ownership (Task X5 Part B, user-approved): this pipeline owns return_1m/3m/ytd/1y/3y/5y on
// etf_performances (direct overwrite, including null — see returnsWriter.ts) and the matching six
// columns on `etfs` (COALESCE, feeding /api/rankings/performance). return_1d/return_6m on
// etf_performances belong exclusively to app/api/cron/cloud-etf-price/route.ts and are never
// referenced here. lib/yahoo/etfEnrich.ts no longer writes any return_* column at all.
//
// SHADOW MODE BY DEFAULT: unless ETF_RETURNS_SYNC_WRITE is exactly "on"
// (lib/etf-returns-sync/writeGate.ts), this route fetches and classifies but writes nothing.
//
// Completion tracking (Task X5 Part 2a): an ETF counts as "done for today" based on its own
// `lastProcessedDate` entry (persisted in the checkpoint, set only on an actual successful write) —
// NOT on whether etf_performances has a row dated today, because resolveWriteDate below can
// deliberately write onto an earlier date to merge with cloud-etf-price's own row, which would
// otherwise make that etf look "missing" forever.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { parseTrailingReturns } from "@/lib/etf-returns-sync/parseReturns";
import { getAuth, invalidateAuth } from "@/lib/services/dataProviders/yahoo/yahooClient";
import { isWriteEnabled, currentRunMode, writeEnvDiagnostic } from "@/lib/etf-returns-sync/writeGate";
import { writeBatchIfEnabled, type WriteCandidate, type TrailingReturns } from "@/lib/etf-returns-sync/returnsWriter";
import {
  nextStateAfterOutcome, orderForInvocation, type EtfFailureStateMap,
} from "@/lib/etf-returns-sync/failureState";
import { missingForToday, type LastProcessedDateMap } from "@/lib/etf-returns-sync/completion";

const JOB = "ETF_RETURNS_SYNC";
const TIME_BUDGET_MS = 240_000;
const REQUEST_DELAY_MS = 400; // matches the existing Yahoo ETF enrichment pipeline's own pacing
const RECENT_PRICE_WINDOW_DAYS = 7;
const CHECKPOINT_KEY = "etf-returns-sync:cursor";

const writerQuery = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function todayLocalDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Task X3 item B.1: the etf_history-based core-universe query (even in market-close-sync's own,
 * already-"proven" shape) measured 80-120 SECONDS live against the real DB this session — a full
 * sequential scan + sort of all 18M+ etf_history rows, far over the 5s target, and almost certainly
 * why Production's etf-returns-sync crashed with a statement timeout. Replaced entirely: the
 * candidate list is now just `etfs` rows whose price_updated_at falls within the last 7 days — a
 * single-table, indexed-column query, no etf_history join, no window function, no full-table scan.
 * This is intentionally a DIFFERENT (simpler, looser) membership rule than market-close-sync's own
 * core-universe definition — not imported from lib/market-close-sync/coreUniverse.ts, and market-
 * close-sync's code is not touched by this task at all (explicit freeze during its acceptance
 * window). */
async function computeRecentlyPricedIds(): Promise<Set<string>> {
  const rows = await prisma.etf.findMany({
    where: { isActive: true, dataSource: { not: null }, priceUpdatedAt: { gte: new Date(Date.now() - RECENT_PRICE_WINDOW_DAYS * 24 * 60 * 60 * 1000) } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

const CANDIDATE_LIST_CACHE_KEY = "etf-returns-sync:candidate-list-cache";

/** Task X3 item B.2: computed at most once per calendar day and cached in the checkpoint table (no
 * new table, no schema change) — every other invocation that same day reuses the cached id list. */
async function getCandidateIdsCachedForToday(today: string): Promise<Set<string>> {
  const cached = await readCheckpoint(CANDIDATE_LIST_CACHE_KEY);
  try {
    const parsed = cached?.lastSymbol ? JSON.parse(cached.lastSymbol) : null;
    if (parsed?.date === today && Array.isArray(parsed?.ids)) return new Set(parsed.ids);
  } catch { /* corrupt/old cache entry — recompute below */ }

  const ids = await computeRecentlyPricedIds();
  await writeCheckpoint(JOB, CANDIDATE_LIST_CACHE_KEY, `cache:${today}`, {
    lastSymbol: JSON.stringify({ date: today, ids: [...ids] }),
    processed: ids.size, succeeded: ids.size, failed: 0,
  });
  return ids;
}

// missingForToday / LastProcessedDateMap moved to lib/etf-returns-sync/completion.ts (Task X5 Part
// 2a) so the completion rule can be unit-tested without pulling in this route's Next.js/Prisma
// imports.

// Task X5 Part B (date alignment): cloud-etf-price writes `date` as the latest TRADING date it got
// back from Yahoo's chart API (can lag "today" over a weekend/holiday or while its own hourly sweep
// is still catching up), while this pipeline previously always wrote `date = today` (processing
// date). When those two differ for the same etf_id, the app's "latest row per etf" selection
// (ORDER BY date DESC LIMIT 1) picks whichever row has the newer date — so a fresh etf-returns-sync
// row at today's date would orphan cloud-etf-price's own row and its return_1d/return_6m would
// disappear from what the app shows, even though the data is still sitting in an older row.
// Fix: before writing, check whether a row already exists for this etf within the last few days; if
// so, write onto THAT row's date (merging with whatever cloud-etf-price already put there) instead
// of creating a new one at today's date. This is exactly why completion tracking (missingForToday,
// below) cannot be based on etf_performances' own `date` column — see Task X5 Part 2a.
const DATE_ALIGNMENT_WINDOW_DAYS = 3;
async function resolveWriteDate(etfId: string, today: string): Promise<string> {
  const rows = await prisma.etfPerformance.findMany({
    where: { etfId, date: { gte: new Date(Date.now() - DATE_ALIGNMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000) } },
    orderBy: { date: "desc" },
    take: 1,
    select: { date: true },
  });
  return rows[0] ? rows[0].date.toISOString().slice(0, 10) : today;
}

const UA = "Mozilla/5.0";

export type FetchAttemptResult = {
  outcomeKind: "SUCCESS" | "NO_FUND_PERFORMANCE" | "TRANSIENT_FAILURE";
  rateLimited: boolean; // 401/403/429 after exhausting retries — caller stops the whole invocation, same as market-close-sync's sparkClient contract
  result: any | null;
};

/** Task X2 item A: live investigation this session found the 47% failure rate was 100% HTTP 404
 * with Yahoo's own "No fundamentals data found for symbol: X" message — never a genuine
 * symbol-format problem or program bug. Classifying that precisely requires the raw response body,
 * which lib/yahoo/productSession.ts's fetchQuoteSummary doesn't expose to its caller — so this
 * feature does its own raw fetch, reusing the SAME getAuth/invalidateAuth crumb primitives that
 * module (and the whole existing Yahoo ETF enrichment pipeline) already relies on, rather than
 * reinventing crumb negotiation. */
async function fetchFundPerformanceRaw(symbol: string): Promise<FetchAttemptResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const auth = await getAuth();
    if (!auth) { if (attempt < 2) { await sleep(1000); continue; } return { outcomeKind: "TRANSIENT_FAILURE", rateLimited: false, result: null }; }
    let r: Response;
    try {
      r = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=fundPerformance&crumb=${encodeURIComponent(auth.crumb)}`,
        { headers: { "user-agent": UA, accept: "application/json", cookie: auth.cookie }, signal: AbortSignal.timeout(20_000) },
      );
    } catch {
      if (attempt < 2) continue;
      return { outcomeKind: "TRANSIENT_FAILURE", rateLimited: false, result: null };
    }
    if (r.status === 401 || r.status === 403) { invalidateAuth(); if (attempt < 2) continue; return { outcomeKind: "TRANSIENT_FAILURE", rateLimited: true, result: null }; }
    if (r.status === 429) { if (attempt < 2) { await sleep((attempt + 1) * 4000); continue; } return { outcomeKind: "TRANSIENT_FAILURE", rateLimited: true, result: null }; }
    const text = await r.text();
    if (r.status === 404 && text.includes("No fundamentals data found")) return { outcomeKind: "NO_FUND_PERFORMANCE", rateLimited: false, result: null };
    if (!r.ok) { if (attempt < 2 && r.status >= 500) { await sleep((attempt + 1) * 4000); continue; } return { outcomeKind: "TRANSIENT_FAILURE", rateLimited: false, result: null }; }
    let json: any;
    try { json = JSON.parse(text); } catch { return { outcomeKind: "TRANSIENT_FAILURE", rateLimited: false, result: null }; }
    const result = json?.quoteSummary?.result?.[0];
    if (!result?.fundPerformance?.trailingReturns) return { outcomeKind: "TRANSIENT_FAILURE", rateLimited: false, result: null };
    return { outcomeKind: "SUCCESS", rateLimited: false, result };
  }
  return { outcomeKind: "TRANSIENT_FAILURE", rateLimited: false, result: null };
}

// parseTrailingReturns moved to lib/etf-returns-sync/parseReturns.ts (Task X5 Part A) so it can be
// unit-tested without pulling in this route's Next.js/Prisma imports.

type EtfRow = { id: string; code: string; data_source: string };

const ALL_NULL_RETURNS: TrailingReturns = {
  r1d: null, r1m: null, r3m: null, r6m: null, rytd: null, r1y: null, r3y: null, r5y: null,
};

// Task X5 Part 2b (user-approved): lib/yahoo/etfEnrich.ts used to be the only writer of these six
// `etfs` flattened columns (confirmed VERIFIED: app/api/rankings/performance/route.ts's
// ETF_PERIOD_COLUMN reads exactly return_1m/3m/6m/1y/3y/5y off `etfs`, nothing else does). Now that
// etfEnrich.ts no longer writes any return_*, this pipeline takes over — same columns, same
// COALESCE-never-overwrite-with-null semantics etfEnrich.ts always used here (deliberately NOT the
// direct-overwrite rule used for etf_performances above: that rule exists specifically to fix the
// 0-vs-null conflation bug for THAT table; parseTrailingReturns already guarantees a clean null
// reaches here, so COALESCE is safe and, for this ranking-display table, the more conservative
// choice — never erase a real ranking value this pipeline doesn't have an opinion on). r6m is always
// null here (Yahoo's trailingReturns has no 6-month figure in this module, same gap etfEnrich.ts
// always had), so this is a harmless no-op for that one column, same as before.
async function writeEtfsRankingColumns(etfId: string, returns: TrailingReturns): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE etfs SET
         return_1m = COALESCE($2, return_1m), return_3m = COALESCE($3, return_3m), return_6m = COALESCE($4, return_6m),
         return_ytd = COALESCE($5, return_ytd), return_1y = COALESCE($6, return_1y),
         return_3y = COALESCE($7, return_3y), return_5y = COALESCE($8, return_5y), updated_at = NOW()
       WHERE id = $1`,
      etfId, returns.r1m, returns.r3m, returns.r6m, returns.rytd, returns.r1y, returns.r3y, returns.r5y,
    );
  } catch { /* ranking-column refresh is best-effort; never block the main return_* sweep */ }
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const today = todayLocalDate();
  const writeEnabledThisRun = isWriteEnabled();

  const coreUniverseIds = await getCandidateIdsCachedForToday(today);
  const coreIdsArray = [...coreUniverseIds];

  // Task X2 item B: persisted failure-state map (lib/etf-returns-sync/failureState.ts) replaces the
  // old plain id-cursor. A never-attempted ETF (no entry) is always eligible; an entry's own
  // skipUntilDate/nextRetryAtMs decides eligibility for everything else. The map has no "today"
  // field of its own — it's checked fresh against `today` every invocation, so it survives across
  // calendar days exactly as item B.1/B.2 require (a 7-day skip, or a backoff that spans midnight).
  // Loaded BEFORE computing missingIds (Task X5 Part 2a) since missingIds now depends on
  // lastProcessedDate, which lives in this same checkpoint blob.
  const before = await readCheckpoint(CHECKPOINT_KEY);
  let failureStateMap: EtfFailureStateMap = {};
  let lastProcessedDate: LastProcessedDateMap = {};
  let preexistingSkipNoPerfBackfillDone = false;
  let backfilledIds: string[] = [];
  try {
    const persisted = before?.lastSymbol ? JSON.parse(before.lastSymbol) : null;
    if (persisted?.failureState) failureStateMap = persisted.failureState;
    if (persisted?.lastProcessedDate) lastProcessedDate = persisted.lastProcessedDate;
    if (persisted?.preexistingSkipNoPerfBackfillDone) preexistingSkipNoPerfBackfillDone = true;
    if (Array.isArray(persisted?.backfilledIds)) backfilledIds = persisted.backfilledIds;
  } catch { /* corrupt/old checkpoint — start fresh rather than block the sweep */ }

  // Task X5 Part 2c (one-time, user-approved): ETFs already in SKIP_NO_PERF state before this
  // deploy were classified NO_FUND_PERFORMANCE under the OLD code, which never wrote any row at all
  // for that outcome — so they're missing the all-null row Part B.3 now writes on first
  // determination. Backfill them exactly once: no new Yahoo calls (the outcome is already known from
  // the persisted failureStateMap), just a batched write. Bounded by its OWN small time budget
  // (counted from this invocation's startedMs, same clock the main loop uses) — an unbounded version
  // of this loop was deployed once and caused a live 300s Vercel function timeout on every single
  // invocation (255 SKIP_NO_PERF entries, two sequential DB round-trips each, no budget check at
  // all), which blocked the entire pipeline since this block runs before beginRun. Progress is
  // tracked incrementally in `backfilledIds` and persisted after every invocation's chunk — not only
  // once the whole list is done — so a slow connection just spreads this bootstrap step over a few
  // extra invocations instead of ever blocking anything.
  const BACKFILL_TIME_BUDGET_MS = 30_000;
  if (!preexistingSkipNoPerfBackfillDone) {
    const preexistingSkipIds = Object.keys(failureStateMap).filter((id) => failureStateMap[id]?.kind === "SKIP_NO_PERF");
    const alreadyBackfilled = new Set(backfilledIds);
    const remaining = preexistingSkipIds.filter((id) => !alreadyBackfilled.has(id));
    let backfillWritten = 0;
    let backfillProcessedThisInvocation = 0;
    for (const etfId of remaining) {
      if (Date.now() - startedMs > BACKFILL_TIME_BUDGET_MS) break;
      try {
        const writeDate = await resolveWriteDate(etfId, today);
        const candidate: WriteCandidate = { etfId, date: writeDate, returns: ALL_NULL_RETURNS };
        const writeResult = await writeBatchIfEnabled(writerQuery, [candidate], new Date().toISOString(), writeEnabledThisRun);
        backfillWritten += writeResult.written;
      } catch { /* one bad backfill candidate never blocks the rest or the main sweep below */ }
      alreadyBackfilled.add(etfId);
      backfillProcessedThisInvocation++;
    }
    if (alreadyBackfilled.size >= preexistingSkipIds.length) preexistingSkipNoPerfBackfillDone = true;
    backfilledIds = [...alreadyBackfilled]; // keep in sync so the end-of-run checkpoint write below doesn't regress this
    try {
      await writeCheckpoint(JOB, CHECKPOINT_KEY, `backfill:${today}`, {
        lastSymbol: JSON.stringify({
          failureState: failureStateMap, lastProcessedDate,
          preexistingSkipNoPerfBackfillDone, backfilledIds,
        }),
        processed: backfillProcessedThisInvocation, succeeded: backfillWritten, failed: 0,
      });
    } catch { /* checkpoint write failure here just means this backfill chunk may repeat next invocation — not fatal */ }
  }

  const missingIds = missingForToday(coreIdsArray, lastProcessedDate, today);

  const runKey = `etf-returns-sync:${today}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_QUOTE_SUMMARY", runKey,
    universeCount: coreUniverseIds.size, batchSize: 1, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present today", runKey, runMode: currentRunMode() });
  }

  if (missingIds.length === 0) {
    await finishRun(runId, JOB, "YAHOO_QUOTE_SUMMARY", startedMs, {
      status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: null, details: { run_mode: currentRunMode(), core_universe_size: coreUniverseIds.size, missing_count: 0 },
    });
    return Response.json({ ok: true, job: JOB, runId, status: "COMPLETED", runMode: currentRunMode(), missingCount: 0, coreUniverseSize: coreUniverseIds.size });
  }

  const nowMsForOrdering = Date.now();
  const orderedMissing = orderForInvocation(missingIds, failureStateMap, today, nowMsForOrdering);
  const notYetDueCount = missingIds.length - orderedMissing.length;

  const rows = await prisma.$queryRawUnsafe<EtfRow[]>(
    `SELECT id, code, data_source FROM etfs WHERE id = ANY($1::text[])`,
    orderedMissing,
  );
  const rowById = new Map(rows.map((r) => [r.id, r]));

  let attempted = 0, written = 0, noFundPerformanceCount = 0, transientFailureCount = 0, writeErrorCount = 0, droppedFieldCount = 0;
  let noFundPerformanceFirstWriteCount = 0;
  let timeBudgetStop = false;
  let rateLimitStop = false;

  for (const etfId of orderedMissing) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    if (rateLimitStop) break;
    const row = rowById.get(etfId);
    if (!row) continue; // stale id, no longer a real etfs row — never blocks the sweep, no state recorded

    attempted++;
    let fetchResult: FetchAttemptResult;
    try {
      fetchResult = await fetchFundPerformanceRaw(row.data_source);
    } catch {
      fetchResult = { outcomeKind: "TRANSIENT_FAILURE", rateLimited: false, result: null };
    }
    if (fetchResult.rateLimited) {
      rateLimitStop = true; // Task X's own A4 rule, applied here too: never retry around a 401/403/429, stop this invocation
      break;
    }

    const wasAlreadySkipNoPerf = failureStateMap[etfId]?.kind === "SKIP_NO_PERF";

    if (fetchResult.outcomeKind === "SUCCESS") {
      const returns = parseTrailingReturns(fetchResult.result);
      const writeDate = await resolveWriteDate(row.id, today);
      const candidate: WriteCandidate = { etfId: row.id, date: writeDate, returns };
      const writeResult = await writeBatchIfEnabled(writerQuery, [candidate], new Date().toISOString(), writeEnabledThisRun);
      written += writeResult.written;
      writeErrorCount += writeResult.writeErrorCount;
      droppedFieldCount += writeResult.droppedFieldCount;
      if (writeEnabledThisRun && writeResult.written > 0) {
        lastProcessedDate[row.id] = today;
        await writeEtfsRankingColumns(row.id, returns);
      }
    } else if (fetchResult.outcomeKind === "NO_FUND_PERFORMANCE") {
      noFundPerformanceCount++;
      // Task X5 Part B.3: record "Yahoo has no data" as an explicit all-null row, but only on the
      // FIRST determination (the transition into SKIP_NO_PERF) — not on every re-confirmation after
      // the 7-day skip window reopens, which would otherwise create a fresh dated row every 7 days
      // for an ETF that will never have fund performance data.
      if (!wasAlreadySkipNoPerf) {
        const writeDate = await resolveWriteDate(row.id, today);
        const candidate: WriteCandidate = { etfId: row.id, date: writeDate, returns: ALL_NULL_RETURNS };
        const writeResult = await writeBatchIfEnabled(writerQuery, [candidate], new Date().toISOString(), writeEnabledThisRun);
        written += writeResult.written;
        writeErrorCount += writeResult.writeErrorCount;
        noFundPerformanceFirstWriteCount++;
        if (writeEnabledThisRun && writeResult.written > 0) lastProcessedDate[row.id] = today;
      }
    } else {
      transientFailureCount++;
    }

    const nextState = nextStateAfterOutcome(failureStateMap[etfId], fetchResult.outcomeKind, today, Date.now());
    if (nextState) failureStateMap[etfId] = nextState;
    else delete failureStateMap[etfId];

    await sleep(REQUEST_DELAY_MS);
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: JSON.stringify({ failureState: failureStateMap, lastProcessedDate, preexistingSkipNoPerfBackfillDone, backfilledIds }),
    processed: attempted, succeeded: written, failed: noFundPerformanceCount + transientFailureCount + writeErrorCount,
  });

  const status = rateLimitStop || timeBudgetStop ? "PARTIAL" : "COMPLETED";
  const writeEnvDiag = writeEnvDiagnostic();
  const fetchFailed = noFundPerformanceCount + transientFailureCount;
  await finishRun(runId, JOB, "YAHOO_QUOTE_SUMMARY", startedMs, {
    status, attempted, completed: written, inserted: written, updated: 0, failed: fetchFailed + writeErrorCount, retryableFailures: transientFailureCount,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), core_universe_size: coreUniverseIds.size, missing_count_at_start: missingIds.length,
      not_yet_due_count: notYetDueCount, attempted, written,
      no_fund_performance_count: noFundPerformanceCount, no_fund_performance_first_write_count: noFundPerformanceFirstWriteCount,
      transient_failure_count: transientFailureCount,
      write_error_count: writeErrorCount, dropped_field_count: droppedFieldCount, rate_limit_stop: rateLimitStop,
      failure_state_map_size: Object.keys(failureStateMap).length,
      write_env_read_exactly_on: writeEnvDiag.readExactlyOn, write_env_var_present: writeEnvDiag.envVarPresent,
      deployment_id: writeEnvDiag.deploymentId, deployment_url: writeEnvDiag.deploymentUrl,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    coreUniverseSize: coreUniverseIds.size, missingCountAtStart: missingIds.length, notYetDueCount,
    attempted, written, noFundPerformanceCount, transientFailureCount, writeErrorCount, droppedFieldCount,
    timeBudgetStop, rateLimitStop,
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
