// Task Y Part B.2 (user-approved): a fund whose Spark response has no candle at all for the target
// date (delisted, or Yahoo simply has no data for that symbol) is classified SKIP_NO_DATA — a
// terminal-for-now skip, re-checked only after 7 days, so it never occupies a scheduling slot every
// run the way a genuinely-retryable failure would. Deliberately a SEPARATE module from
// lib/etf-returns-sync/failureState.ts (not shared/imported) — same backoff philosophy, proven
// there, but kept fully independent so a change to one pipeline's state machine can never affect the
// other's.

export type FundOutcomeKind = "SUCCESS" | "NO_DATA" | "TRANSIENT_FAILURE";

export type FundFailureState =
  | { kind: "SKIP_NO_DATA"; skipUntilDate: string }
  | { kind: "RETRY"; attempts: number; nextRetryAtMs: number; lastFailureDate: string };

export type FundFailureStateMap = Record<string, FundFailureState>;

const SKIP_NO_DATA_DAYS = 7;
const BACKOFF_HOURS = [1, 6, 24];
const MAX_SAME_DAY_ATTEMPTS = 3;

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function nextStateAfterOutcome(
  prior: FundFailureState | undefined,
  outcome: FundOutcomeKind,
  today: string,
  nowMs: number,
): FundFailureState | null {
  if (outcome === "SUCCESS") return null; // nothing left to remember once a real NAV is in hand
  if (outcome === "NO_DATA") return { kind: "SKIP_NO_DATA", skipUntilDate: addDays(today, SKIP_NO_DATA_DAYS) };

  // TRANSIENT_FAILURE: same-day attempt count resets whenever `today` differs from the stored
  // lastFailureDate — a stale RETRY state from a prior day never carries over its attempt count.
  const sameDayAttempts = prior?.kind === "RETRY" && prior.lastFailureDate === today ? prior.attempts : 0;
  const attempt = sameDayAttempts + 1;
  if (attempt > MAX_SAME_DAY_ATTEMPTS) {
    // 4th+ same-day failure: park until the start of the next calendar day rather than a short backoff.
    const tomorrow = addDays(today, 1);
    return { kind: "RETRY", attempts: attempt, nextRetryAtMs: new Date(`${tomorrow}T00:00:00Z`).getTime(), lastFailureDate: today };
  }
  const hours = BACKOFF_HOURS[Math.min(attempt - 1, BACKOFF_HOURS.length - 1)];
  return { kind: "RETRY", attempts: attempt, nextRetryAtMs: nowMs + hours * 60 * 60 * 1000, lastFailureDate: today };
}

export function isEligibleNow(state: FundFailureState | undefined, today: string, nowMs: number): boolean {
  if (!state) return true;
  if (state.kind === "SKIP_NO_DATA") return today >= state.skipUntilDate;
  return nowMs >= state.nextRetryAtMs;
}

/** Never-attempted ids (no map entry) always sort ahead of anything with a state entry, so a large
 * backlog of retrying/skipped funds can never crowd out funds that haven't had their first try yet —
 * same forward-progress guarantee Task X2 B.3 established for etf-returns-sync. */
export function orderForInvocation(candidateIds: string[], stateMap: FundFailureStateMap, today: string, nowMs: number): string[] {
  const eligible = candidateIds.filter((id) => isEligibleNow(stateMap[id], today, nowMs));
  const neverAttempted = eligible.filter((id) => !stateMap[id]);
  const dueForRetry = eligible.filter((id) => !!stateMap[id]);
  return [...neverAttempted.sort(), ...dueForRetry.sort()];
}
