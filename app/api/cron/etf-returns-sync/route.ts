// Task X: daily ETF return sync — writes ONLY Yahoo's own fundPerformance.trailingReturns numbers
// into etf_performances (1M/3M/YTD/1Y/3Y/5Y; 3Y/5Y are Yahoo's own ANNUALIZED figures, confirmed live
// this session against an independently-computed CAGR). Never computes a return itself. A brand-new
// file/endpoint — does not modify lib/yahoo/etfEnrich.ts or any existing cron route; reuses the
// SAME upsert shape that pipeline already uses (lib/etf-returns-sync/returnsWriter.ts), so the two
// pipelines coexist on the same table without clobbering each other's columns (COALESCE-based).
//
// SHADOW MODE BY DEFAULT: unless ETF_RETURNS_SYNC_WRITE is exactly "on"
// (lib/etf-returns-sync/writeGate.ts), this route fetches and classifies but writes nothing.
//
// Completion is DB-truth based, not checkpoint-based (Task X item B.3, same principle Task W4/W6
// established for market-close-sync): an ETF counts as "done for today" only if etf_performances
// already has a row for it dated today. The checkpoint below is purely a forward-sweep cursor for
// ordering within one invocation's time budget — never trusted to mean "done" on its own.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { rawNum } from "@/lib/yahoo/productSession";
import { getAuth, invalidateAuth } from "@/lib/services/dataProviders/yahoo/yahooClient";
import { isWriteEnabled, currentRunMode, writeEnvDiagnostic } from "@/lib/etf-returns-sync/writeGate";
import { writeBatchIfEnabled, type WriteCandidate, type TrailingReturns } from "@/lib/etf-returns-sync/returnsWriter";
import {
  nextStateAfterOutcome, orderForInvocation, type EtfFailureStateMap,
} from "@/lib/etf-returns-sync/failureState";

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

/** DB-truth: which core-universe ETFs are still missing a return row for `date`. Prisma
 * findMany/where/in, batched at 1,000 — never a handwritten `= ANY($1)` array bind (Task W6's fix
 * applied here from the start, not retrofitted after a crash). */
async function lookupMissingForDate(coreIds: string[], date: string): Promise<string[]> {
  if (coreIds.length === 0) return [];
  const present = new Set<string>();
  const BATCH = 1000;
  for (let i = 0; i < coreIds.length; i += BATCH) {
    const batch = coreIds.slice(i, i + BATCH);
    const rows = await prisma.etfPerformance.findMany({
      where: { etfId: { in: batch }, date: new Date(`${date}T00:00:00.000Z`) },
      select: { etfId: true },
    });
    for (const r of rows) present.add(r.etfId);
  }
  return coreIds.filter((id) => !present.has(id));
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

function parseTrailingReturns(result: any): TrailingReturns {
  const t = result?.fundPerformance?.trailingReturns ?? {};
  const pctOf = (v: any): number | null => {
    const raw = rawNum(v);
    if (raw == null) return null;
    // Same convention as the existing Yahoo ETF enrichment pipeline: a fmt string containing "%", or
    // a raw magnitude small enough to plausibly be a fraction (<=2), is treated as a fraction and
    // scaled to percent units; otherwise the raw value is already in percent units.
    const fmt = v && typeof v === "object" && typeof v.fmt === "string" ? v.fmt : "";
    return fmt.includes("%") || Math.abs(raw) <= 2 ? raw * 100 : raw;
  };
  return {
    r1d: pctOf(t.oneDay), r1m: pctOf(t.oneMonth), r3m: pctOf(t.threeMonth), r6m: pctOf(t.sixMonth),
    rytd: pctOf(t.ytd), r1y: pctOf(t.oneYear), r3y: pctOf(t.threeYear), r5y: pctOf(t.fiveYear),
  };
}

type EtfRow = { id: string; code: string; data_source: string };

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const today = todayLocalDate();
  const writeEnabledThisRun = isWriteEnabled();

  const coreUniverseIds = await getCandidateIdsCachedForToday(today);
  const coreIdsArray = [...coreUniverseIds];
  const missingIds = await lookupMissingForDate(coreIdsArray, today);
  const missingSet = new Set(missingIds);

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

  // Task X2 item B: persisted failure-state map (lib/etf-returns-sync/failureState.ts) replaces the
  // old plain id-cursor. A never-attempted ETF (no entry) is always eligible; an entry's own
  // skipUntilDate/nextRetryAtMs decides eligibility for everything else. The map has no "today"
  // field of its own — it's checked fresh against `today` every invocation, so it survives across
  // calendar days exactly as item B.1/B.2 require (a 7-day skip, or a backoff that spans midnight).
  const before = await readCheckpoint(CHECKPOINT_KEY);
  let failureStateMap: EtfFailureStateMap = {};
  try {
    const persisted = before?.lastSymbol ? JSON.parse(before.lastSymbol) : null;
    if (persisted?.failureState) failureStateMap = persisted.failureState;
  } catch { /* corrupt/old checkpoint — start a fresh map rather than block the sweep */ }

  const nowMsForOrdering = Date.now();
  const orderedMissing = orderForInvocation(missingIds, failureStateMap, today, nowMsForOrdering);
  const notYetDueCount = missingIds.length - orderedMissing.length;

  const rows = await prisma.$queryRawUnsafe<EtfRow[]>(
    `SELECT id, code, data_source FROM etfs WHERE id = ANY($1::text[])`,
    orderedMissing,
  );
  const rowById = new Map(rows.map((r) => [r.id, r]));

  let attempted = 0, written = 0, noFundPerformanceCount = 0, transientFailureCount = 0, writeErrorCount = 0, droppedFieldCount = 0;
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

    if (fetchResult.outcomeKind === "SUCCESS") {
      const returns = parseTrailingReturns(fetchResult.result);
      const candidate: WriteCandidate = { etfId: row.id, date: today, returns };
      const writeResult = await writeBatchIfEnabled(writerQuery, [candidate], new Date().toISOString(), writeEnabledThisRun);
      written += writeResult.written;
      writeErrorCount += writeResult.writeErrorCount;
      droppedFieldCount += writeResult.droppedFieldCount;
    } else if (fetchResult.outcomeKind === "NO_FUND_PERFORMANCE") {
      noFundPerformanceCount++;
    } else {
      transientFailureCount++;
    }

    const nextState = nextStateAfterOutcome(failureStateMap[etfId], fetchResult.outcomeKind, today, Date.now());
    if (nextState) failureStateMap[etfId] = nextState;
    else delete failureStateMap[etfId];

    await sleep(REQUEST_DELAY_MS);
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: JSON.stringify({ failureState: failureStateMap }),
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
      no_fund_performance_count: noFundPerformanceCount, transient_failure_count: transientFailureCount,
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
