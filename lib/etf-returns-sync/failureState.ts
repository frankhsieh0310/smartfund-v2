// Task X2: per-ETF failure bookkeeping, persisted in the checkpoint's JSON blob (same pattern
// lib/market-close-sync/completionState.ts uses — no new table, no schema change). Only ETFs that
// have EVER failed get an entry; a never-attempted or already-successful ETF (reflected by its own
// etf_performances row for today — the DB-truth check in route.ts) needs none at all, keeping this
// map's size roughly bounded by the true failure population, not the whole universe.
//
// Investigation this session (Task X2 item A, live tested against all 218 of the first run's
// attempts) found the 47% failure rate was 100% "No fundamentals data found for symbol: X" — Yahoo
// correctly resolves the symbol, it simply has no fund-performance-type data (leveraged/ETN/niche
// instruments mostly). Zero genuine symbol-format problems, zero program bugs. That specific HTTP 404
// + exact message is NEVER worth retrying — distinguished here as SKIP_NO_PERF, re-checked only
// every 7 days in case Yahoo starts carrying the data later. Any OTHER failure (timeout, 5xx, network
// exception, an empty-but-200 result) is treated as transient and retried with backoff.

export type FetchOutcome = "SUCCESS" | "NO_FUND_PERFORMANCE" | "TRANSIENT_FAILURE";

/** Classifies one fetchQuoteSummary attempt's raw HTTP result. `result` is null when
 * fetchQuoteSummary itself returned null (already exhausted its own internal retries) — in that case
 * the caller doesn't have the original HTTP status, only this feature's own direct check (route.ts
 * does a RAW request first specifically to see the 404+message pattern, since fetchQuoteSummary's
 * own abstraction only exposes categorical reasons, not the body). */
export function classifyFetchOutcome(httpStatus: number | null, bodyText: string | null, hasTrailingReturns: boolean): FetchOutcome {
  if (httpStatus === 404 && bodyText?.includes("No fundamentals data found")) return "NO_FUND_PERFORMANCE";
  if (httpStatus === 200 && hasTrailingReturns) return "SUCCESS";
  return "TRANSIENT_FAILURE";
}

export type EtfFailureState =
  | { kind: "SKIP_NO_PERF"; skipUntilDate: string } // YYYY-MM-DD; re-eligible once today's date >= this
  | { kind: "RETRY"; attempts: number; nextRetryAtMs: number; lastFailureDate: string }; // lastFailureDate resets the backoff sequence on a new calendar day

export type EtfFailureStateMap = Record<string, EtfFailureState>;

const SKIP_NO_PERF_RECHECK_DAYS = 7;
// Task X2 item B.2: 1h -> 6h -> 24h backoff; a 4th failure the SAME day stops retrying until tomorrow.
const RETRY_BACKOFF_MS = [1 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const MAX_RETRIES_PER_DAY = 3;

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Pure state transition: given the PRIOR state (if any) for one ETF and today's fetch outcome,
 * returns the new state to persist (or null to delete the entry — SUCCESS always clears it, there's
 * nothing left to remember once etf_performances itself proves today's row exists). */
export function nextStateAfterOutcome(
  prior: EtfFailureState | undefined,
  outcome: FetchOutcome,
  today: string,
  nowMs: number,
): EtfFailureState | null {
  if (outcome === "SUCCESS") return null;
  if (outcome === "NO_FUND_PERFORMANCE") return { kind: "SKIP_NO_PERF", skipUntilDate: addDays(today, SKIP_NO_PERF_RECHECK_DAYS) };

  // TRANSIENT_FAILURE
  const isSameDayRetry = prior?.kind === "RETRY" && prior.lastFailureDate === today;
  const attempts = isSameDayRetry ? prior.attempts + 1 : 1;
  if (attempts > MAX_RETRIES_PER_DAY) {
    // Task X2 item B.2: "3次失敗後當天不再重試" — park it past end-of-day; tomorrow's run sees a new
    // calendar day and restarts the backoff sequence from attempt 1 via isSameDayRetry being false.
    return { kind: "RETRY", attempts, nextRetryAtMs: new Date(`${addDays(today, 1)}T00:00:00.000Z`).getTime(), lastFailureDate: today };
  }
  const backoffMs = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
  return { kind: "RETRY", attempts, nextRetryAtMs: nowMs + backoffMs, lastFailureDate: today };
}

/** Whether an ETF with this (possibly absent) state is eligible to be attempted right now. Absent
 * state (never failed before) is always eligible — this is what lets a never-attempted ETF proceed
 * without route.ts needing any special-case "first time" branch. */
export function isEligibleNow(state: EtfFailureState | undefined, today: string, nowMs: number): boolean {
  if (!state) return true;
  if (state.kind === "SKIP_NO_PERF") return today >= state.skipUntilDate;
  return nowMs >= state.nextRetryAtMs;
}

/** Task X2 item B.3: never-attempted ETFs (no entry in the map at all) are always prioritized ahead
 * of due-for-retry ETFs, so a run of consecutive failures can never crowd out genuine forward
 * progress through the universe. Both groups are returned in ascending id order within themselves. */
export function orderForInvocation(missingIds: string[], stateMap: EtfFailureStateMap, today: string, nowMs: number): string[] {
  const neverAttempted: string[] = [];
  const dueRetry: string[] = [];
  for (const id of missingIds) {
    const state = stateMap[id];
    if (!state) { neverAttempted.push(id); continue; }
    if (isEligibleNow(state, today, nowMs)) dueRetry.push(id);
  }
  neverAttempted.sort();
  dueRetry.sort();
  return [...neverAttempted, ...dueRetry];
}
