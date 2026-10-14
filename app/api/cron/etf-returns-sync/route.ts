// Task X: daily ETF return sync — writes ONLY Yahoo's own fundPerformance.trailingReturns numbers
// into etf_performances (1M/3M/YTD/1Y/3Y/5Y; 3Y/5Y are Yahoo's own ANNUALIZED figures, confirmed live
// this session against an independently-computed CAGR). Never computes a return itself.
//
// Column ownership (Task X5/X6, user-approved): this pipeline owns return_1m/3m/ytd/1y/3y/5y on
// BOTH etf_performances and `etfs` (feeding /api/rankings/performance) — direct overwrite on both,
// including null (see returnsWriter.ts and batchHelpers.ts's writeEtfsRankingColumnsBatch).
// return_1d on etf_performances belongs exclusively to app/api/cron/cloud-etf-price/route.ts.
// return_6m is cloud-etf-price's own self-computed value on etf_performances, synced (never
// recomputed) onto `etfs.return_6m` by this pipeline (batchHelpers.ts's fetchLatestReturn6mBatch).
// lib/yahoo/etfEnrich.ts no longer writes any return_* column at all.
//
// SHADOW MODE BY DEFAULT: unless ETF_RETURNS_SYNC_WRITE is exactly "on"
// (lib/etf-returns-sync/writeGate.ts), this route fetches and classifies but writes nothing.
//
// Completion tracking (Task X5 Part 2a): an ETF counts as "done for today" based on its own
// `lastProcessedDate` entry (persisted in the checkpoint, set only on an actual successful write) —
// NOT on whether etf_performances has a row dated today, because date alignment (batchHelpers.ts's
// resolveWriteDatesBatch) can deliberately write onto an earlier date to merge with cloud-etf-price's
// own row, which would otherwise make that etf look "missing" forever.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { parseTrailingReturns } from "@/lib/etf-returns-sync/parseReturns";
import { fetchYahooTwPerformance, YahooTwRateLimitedError } from "@/lib/yahoo/twPerformancePage";
import { getAuth, invalidateAuth } from "@/lib/services/dataProviders/yahoo/yahooClient";
import { isWriteEnabled, currentRunMode, writeEnvDiagnostic } from "@/lib/etf-returns-sync/writeGate";
import { writeBatchIfEnabled, type WriteCandidate, type TrailingReturns } from "@/lib/etf-returns-sync/returnsWriter";
import {
  nextStateAfterOutcome, orderForInvocation, type EtfFailureStateMap,
} from "@/lib/etf-returns-sync/failureState";
import { missingForToday, type LastProcessedDateMap, type LastProcessedVersionMap } from "@/lib/etf-returns-sync/completion";
import {
  resolveWriteDatesBatch, fetchLatestReturn6mBatch, writeEtfsRankingColumnsBatch, type EtfsRankingEntry,
} from "@/lib/etf-returns-sync/batchHelpers";

const JOB = "ETF_RETURNS_SYNC";
const TIME_BUDGET_MS = 240_000;
const REQUEST_DELAY_MS = 400; // matches the existing Yahoo ETF enrichment pipeline's own pacing
// 2026-10-14 QA-round-1: TW-listed ETFs (data_source ending .TW/.TWO) now source their returns from
// Yahoo奇摩's own page (lib/yahoo/twPerformancePage.ts) instead of the global API's trailingReturns
// -- see docs/specs/yahoo-return-discrepancy.md. Per the user's instruction this specific call gets
// its own, more conservative 3s+ spacing (distinct from REQUEST_DELAY_MS above, which still applies
// to the unchanged global-API path used for non-TW ETFs).
const YAHOO_TW_REQUEST_DELAY_MS = 3_200;
const RECENT_PRICE_WINDOW_DAYS = 7;
// Task X7: bump this ONLY when the actual data source or calculation changes (e.g. switching Yahoo
// pages, changing which navReturn/trailingReturns field feeds return_1y, etc.) -- never automatically
// on every deploy. A bump forces every TW-listed ETF to be reprocessed once, same-day, regardless of
// its lastProcessedDate; see lib/etf-returns-sync/completion.ts's missingForToday.
const ETF_RETURNS_SOURCE_VERSION = "yahoo-tw-v1";
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

/** Task X3 item B.2 (original) cached this once per calendar day, discarding and recomputing from
 * scratch on the first invocation of a new day — found live (2026-10-11/12 overnight check) to miss
 * any ETF whose price_updated_at crosses into the 7-day window LATER the same day (VERIFIED:
 * BTC2.AS's price refreshed at 09:19:30, after that day's 07:45:06 cache snapshot, so it sat on a
 * stale pre-fix row until the next day's cache recompute — 164 ETFs were in the same situation at
 * the time this was found). Fixed to an incremental merge: every invocation re-runs the underlying
 * query (cheap — Task X3 measured it at ~451ms, a single indexed-column scan, nothing like the old
 * etf_history-based query this cache was originally built to avoid) and UNIONS it into whatever is
 * already cached for today, instead of replacing it. Once an ETF is in today's list it stays there
 * even if its price_updated_at later ages back out of the 7-day window mid-day — a conservative
 * choice (never shrinks the list intra-day) that matches the original cache's own one-way daily
 * reset semantics. The checkpoint is only rewritten when the merged set actually changed, so a
 * steady-state day (no newly-eligible ETFs) doesn't churn the checkpoint table every 15 minutes. */
async function getCandidateIdsCachedForToday(today: string): Promise<Set<string>> {
  const cached = await readCheckpoint(CANDIDATE_LIST_CACHE_KEY);
  let existingIds: string[] = [];
  let cacheIsFromToday = false;
  try {
    const parsed = cached?.lastSymbol ? JSON.parse(cached.lastSymbol) : null;
    if (parsed?.date === today && Array.isArray(parsed?.ids)) { existingIds = parsed.ids; cacheIsFromToday = true; }
  } catch { /* corrupt/old cache entry — treat as empty, recompute+merge below */ }

  const freshIds = await computeRecentlyPricedIds();
  const merged = new Set([...existingIds, ...freshIds]);

  if (!cacheIsFromToday || merged.size !== existingIds.length) {
    await writeCheckpoint(JOB, CANDIDATE_LIST_CACHE_KEY, `cache:${today}`, {
      lastSymbol: JSON.stringify({ date: today, ids: [...merged] }),
      processed: merged.size, succeeded: merged.size, failed: 0,
    });
  }
  return merged;
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

// resolveWriteDatesBatch / fetchLatestReturn6mBatch / writeEtfsRankingColumnsBatch moved to
// lib/etf-returns-sync/batchHelpers.ts (Task X6 Part B/C) so they're unit-testable without pulling
// in this route's Next.js/Prisma imports.

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
  let lastProcessedVersion: LastProcessedVersionMap = {};
  let preexistingSkipNoPerfBackfillDone = false;
  let backfilledIds: string[] = [];
  try {
    const persisted = before?.lastSymbol ? JSON.parse(before.lastSymbol) : null;
    if (persisted?.failureState) failureStateMap = persisted.failureState;
    if (persisted?.lastProcessedDate) lastProcessedDate = persisted.lastProcessedDate;
    if (persisted?.lastProcessedVersion) lastProcessedVersion = persisted.lastProcessedVersion;
    if (persisted?.preexistingSkipNoPerfBackfillDone) preexistingSkipNoPerfBackfillDone = true;
    if (Array.isArray(persisted?.backfilledIds)) backfilledIds = persisted.backfilledIds;
  } catch { /* corrupt/old checkpoint — start fresh rather than block the sweep */ }

  // Task X5 Part 2c / Task X6 Part B.2 (user-approved): ETFs already in SKIP_NO_PERF state before
  // this deploy were classified NO_FUND_PERFORMANCE under the OLD code, which never wrote any row at
  // all for that outcome — so they're missing the all-null row Part B.3 now writes on first
  // determination. Backfill them exactly once: no new Yahoo calls (the outcome is already known from
  // the persisted failureStateMap). Originally one query per etf (2 sequential DB round-trips each,
  // no time-budget check) — live-measured at ~2.5s/etf, which caused a real 300s Vercel function
  // timeout on every invocation with 255 entries pending, since this block runs before beginRun and
  // blocked the whole pipeline. Fixed by batching the entire backfill into a handful of queries
  // total regardless of list size (one for dates, one write, one r6m sync, one etfs update), so it
  // now finishes in a couple of seconds and the incremental/time-budget machinery is no longer
  // needed — kept only as a defensive fallback via `backfilledIds` in case this list ever grows large
  // enough to need spreading across invocations again.
  const dateAlignmentCutoffIso = new Date(Date.now() - DATE_ALIGNMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (!preexistingSkipNoPerfBackfillDone) {
    const preexistingSkipIds = Object.keys(failureStateMap).filter((id) => failureStateMap[id]?.kind === "SKIP_NO_PERF");
    const alreadyBackfilled = new Set(backfilledIds);
    const remaining = preexistingSkipIds.filter((id) => !alreadyBackfilled.has(id));
    let backfillWritten = 0;
    if (remaining.length > 0) {
      try {
        const dateMap = await resolveWriteDatesBatch(writerQuery, remaining, dateAlignmentCutoffIso);
        const candidates: WriteCandidate[] = remaining.map((etfId) => ({ etfId, date: dateMap.get(etfId) ?? today, returns: ALL_NULL_RETURNS }));
        const writeResult = await writeBatchIfEnabled(writerQuery, candidates, new Date().toISOString(), writeEnabledThisRun);
        backfillWritten = writeResult.written;
        if (writeEnabledThisRun && writeResult.written > 0) {
          const r6mMap = await fetchLatestReturn6mBatch(writerQuery, remaining);
          const entries: EtfsRankingEntry[] = remaining.map((etfId) => ({ etfId, returns: ALL_NULL_RETURNS, return6mSync: r6mMap.get(etfId) ?? null }));
          await writeEtfsRankingColumnsBatch(writerQuery, entries);
        }
      } catch { /* a failed backfill batch just retries next invocation — never blocks the main sweep below */ }
    }
    for (const id of remaining) alreadyBackfilled.add(id);
    if (alreadyBackfilled.size >= preexistingSkipIds.length) preexistingSkipNoPerfBackfillDone = true;
    backfilledIds = [...alreadyBackfilled]; // keep in sync so the end-of-run checkpoint write below doesn't regress this
    try {
      await writeCheckpoint(JOB, CHECKPOINT_KEY, `backfill:${today}`, {
        lastSymbol: JSON.stringify({
          failureState: failureStateMap, lastProcessedDate, lastProcessedVersion,
          preexistingSkipNoPerfBackfillDone, backfilledIds,
        }),
        processed: remaining.length, succeeded: backfillWritten, failed: 0,
      });
    } catch { /* checkpoint write failure here just means this backfill chunk may repeat next invocation — not fatal */ }
  }

  const missingIds = missingForToday(coreIdsArray, lastProcessedDate, today, lastProcessedVersion, ETF_RETURNS_SOURCE_VERSION);

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

  // 2026-10-14 QA-round-1 follow-up: 58 of the 92 duplicate-ETF pairs' KEPT bare-code row (the one
  // actually shown to users, per decision 4-1) has a data_source with NO .TW/.TWO suffix at all
  // (e.g. "006208", not "006208.TW") -- there is no Yahoo symbol to query for it directly, so it was
  // silently stuck on old/stale performance data even before this round. Its hidden duplicate twin
  // (e.g. "006208.TW") DOES have a working data_source. yahooSymbolOverride borrows that twin's
  // data_source purely as a lookup key for the fetch below -- nothing is written back to the bare
  // row's own data_source column, this is read-only borrowing for one HTTP call.
  const rows = await prisma.$queryRawUnsafe<Array<EtfRow & { yahoo_symbol_override: string | null }>>(
    `SELECT bare.id, bare.code, bare.data_source,
            CASE WHEN bare.data_source !~ '\\.(TW|TWO)$'
                 THEN (SELECT suf.data_source FROM etfs suf WHERE suf.code = bare.code || '.TW' OR suf.code = bare.code || '.TWO' LIMIT 1)
                 ELSE NULL END AS yahoo_symbol_override
       FROM etfs bare WHERE bare.id = ANY($1::text[])`,
    orderedMissing,
  );
  const rowById = new Map(rows.map((r) => [r.id, r]));

  let attempted = 0, written = 0, noFundPerformanceCount = 0, transientFailureCount = 0, writeErrorCount = 0, droppedFieldCount = 0;
  let noFundPerformanceFirstWriteCount = 0;
  let timeBudgetStop = false;
  let rateLimitStop = false;

  // Task X6 Part B: the per-etf resolveWriteDate + writeBatchIfEnabled + writeEtfsRankingColumns
  // sequence (3 DB round-trips per etf) was the main cause of the ~53/run throughput regression —
  // Yahoo fetches themselves are unavoidably sequential (rate-limit pacing below), but the DB side of
  // each success doesn't need to be. Buffered here and flushed in FLUSH_BATCH_SIZE-sized batches
  // (one query each for date resolution, the upsert, the r6m sync, and the etfs update — 4 queries
  // per ~40 etfs instead of 3 per etf) so DB overhead drops by roughly FLUSH_BATCH_SIZE x. A flush
  // failure reports the whole buffered batch as writeErrorCount, same error-isolation philosophy as
  // before (Task X B.3), just at this coarser, throughput-driven grain.
  const FLUSH_BATCH_SIZE = 40;
  let pending: Array<{ etfId: string; returns: TrailingReturns }> = [];

  async function flushPending() {
    if (pending.length === 0) return;
    const ids = pending.map((p) => p.etfId);
    const dateMap = await resolveWriteDatesBatch(writerQuery, ids, dateAlignmentCutoffIso);
    const candidates: WriteCandidate[] = pending.map((p) => ({ etfId: p.etfId, date: dateMap.get(p.etfId) ?? today, returns: p.returns }));
    const writeResult = await writeBatchIfEnabled(writerQuery, candidates, new Date().toISOString(), writeEnabledThisRun);
    written += writeResult.written;
    writeErrorCount += writeResult.writeErrorCount;
    droppedFieldCount += writeResult.droppedFieldCount;
    if (writeEnabledThisRun && writeResult.written > 0) {
      for (const p of pending) {
        lastProcessedDate[p.etfId] = today;
        lastProcessedVersion[p.etfId] = ETF_RETURNS_SOURCE_VERSION;
      }
      const r6mMap = await fetchLatestReturn6mBatch(writerQuery, ids);
      const entries: EtfsRankingEntry[] = pending.map((p) => ({ etfId: p.etfId, returns: p.returns, return6mSync: r6mMap.get(p.etfId) ?? null }));
      await writeEtfsRankingColumnsBatch(writerQuery, entries);
    }
    pending = [];
  }

  for (const etfId of orderedMissing) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    if (rateLimitStop) break;
    const row = rowById.get(etfId);
    if (!row) continue; // stale id, no longer a real etfs row — never blocks the sweep, no state recorded

    attempted++;
    const yahooSymbol = row.yahoo_symbol_override ?? row.data_source;
    const isTwListed = /\.(TW|TWO)$/.test(yahooSymbol);
    let fetchResult: FetchAttemptResult;
    let twReturns: TrailingReturns | null = null;
    if (isTwListed) {
      try {
        const perf = await fetchYahooTwPerformance(yahooSymbol);
        if (perf) {
          twReturns = {
            r1d: null, // Yahoo奇摩's performance page has no 1-day figure (owned by cloud-etf-price)
            r1m: perf.navReturn.m1, r3m: perf.navReturn.m3, r6m: perf.navReturn.m6,
            rytd: perf.navReturn.ytd, r1y: perf.navReturn.y1, r3y: perf.navReturn.y3, r5y: perf.navReturn.y5,
          };
          fetchResult = { outcomeKind: "SUCCESS", rateLimited: false, result: null };
        } else {
          fetchResult = { outcomeKind: "NO_FUND_PERFORMANCE", rateLimited: false, result: null };
        }
      } catch (e) {
        if (e instanceof YahooTwRateLimitedError) {
          fetchResult = { outcomeKind: "TRANSIENT_FAILURE", rateLimited: true, result: null };
        } else {
          fetchResult = { outcomeKind: "TRANSIENT_FAILURE", rateLimited: false, result: null };
        }
      }
    } else {
      try {
        fetchResult = await fetchFundPerformanceRaw(yahooSymbol);
      } catch {
        fetchResult = { outcomeKind: "TRANSIENT_FAILURE", rateLimited: false, result: null };
      }
    }
    if (fetchResult.rateLimited) {
      rateLimitStop = true; // Task X's own A4 rule, applied here too: never retry around a 401/403/429, stop this invocation
      break;
    }

    const wasAlreadySkipNoPerf = failureStateMap[etfId]?.kind === "SKIP_NO_PERF";

    if (fetchResult.outcomeKind === "SUCCESS") {
      const returns = twReturns ?? parseTrailingReturns(fetchResult.result);
      pending.push({ etfId: row.id, returns });
    } else if (fetchResult.outcomeKind === "NO_FUND_PERFORMANCE") {
      noFundPerformanceCount++;
      // Task X5 Part B.3: record "Yahoo has no data" as an explicit all-null row, but only on the
      // FIRST determination (the transition into SKIP_NO_PERF) — not on every re-confirmation after
      // the 7-day skip window reopens, which would otherwise create a fresh dated row every 7 days
      // for an ETF that will never have fund performance data.
      if (!wasAlreadySkipNoPerf) {
        pending.push({ etfId: row.id, returns: ALL_NULL_RETURNS });
        noFundPerformanceFirstWriteCount++;
      }
    } else {
      transientFailureCount++;
    }

    const nextState = nextStateAfterOutcome(failureStateMap[etfId], fetchResult.outcomeKind, today, Date.now());
    if (nextState) failureStateMap[etfId] = nextState;
    else delete failureStateMap[etfId];

    if (pending.length >= FLUSH_BATCH_SIZE) await flushPending();

    await sleep(isTwListed ? YAHOO_TW_REQUEST_DELAY_MS : REQUEST_DELAY_MS);
  }
  await flushPending();

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: JSON.stringify({
      failureState: failureStateMap, lastProcessedDate, lastProcessedVersion,
      preexistingSkipNoPerfBackfillDone, backfilledIds,
    }),
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
