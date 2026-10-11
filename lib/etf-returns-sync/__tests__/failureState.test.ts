import assert from "node:assert/strict";
import {
  classifyFetchOutcome, nextStateAfterOutcome, isEligibleNow, orderForInvocation,
  type EtfFailureState, type EtfFailureStateMap,
} from "../failureState.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("classifyFetchOutcome: HTTP 404 + Yahoo's exact message -> NO_FUND_PERFORMANCE", () => {
  assert.equal(classifyFetchOutcome(404, "No fundamentals data found for symbol: XYZ", false), "NO_FUND_PERFORMANCE");
});

test("classifyFetchOutcome: 200 + trailingReturns present -> SUCCESS", () => {
  assert.equal(classifyFetchOutcome(200, "{}", true), "SUCCESS");
});

test("classifyFetchOutcome: any other combination -> TRANSIENT_FAILURE (timeout, 5xx, empty-but-200, a 404 without the exact message)", () => {
  assert.equal(classifyFetchOutcome(500, null, false), "TRANSIENT_FAILURE");
  assert.equal(classifyFetchOutcome(null, null, false), "TRANSIENT_FAILURE");
  assert.equal(classifyFetchOutcome(200, "{}", false), "TRANSIENT_FAILURE");
  assert.equal(classifyFetchOutcome(404, "some other 404 body", false), "TRANSIENT_FAILURE");
});

test("nextStateAfterOutcome: SUCCESS always clears any prior state", () => {
  const prior: EtfFailureState = { kind: "RETRY", attempts: 2, nextRetryAtMs: 123, lastFailureDate: "2026-10-11" };
  assert.equal(nextStateAfterOutcome(prior, "SUCCESS", "2026-10-11", 456), null);
});

test("nextStateAfterOutcome: NO_FUND_PERFORMANCE sets a 7-day skip from today", () => {
  const state = nextStateAfterOutcome(undefined, "NO_FUND_PERFORMANCE", "2026-10-11", Date.now());
  assert.deepEqual(state, { kind: "SKIP_NO_PERF", skipUntilDate: "2026-10-18" });
});

test("nextStateAfterOutcome: first TRANSIENT_FAILURE of the day -> attempt 1, ~1h backoff", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  const state = nextStateAfterOutcome(undefined, "TRANSIENT_FAILURE", "2026-10-11", now);
  assert.equal(state?.kind, "RETRY");
  if (state?.kind === "RETRY") {
    assert.equal(state.attempts, 1);
    assert.equal(state.nextRetryAtMs, now + 60 * 60 * 1000);
    assert.equal(state.lastFailureDate, "2026-10-11");
  }
});

test("nextStateAfterOutcome: 1h -> 6h -> 24h backoff sequence across same-day retries", () => {
  const t0 = Date.parse("2026-10-11T00:00:00.000Z");
  let state = nextStateAfterOutcome(undefined, "TRANSIENT_FAILURE", "2026-10-11", t0);
  assert.equal(state?.kind === "RETRY" && state.attempts, 1);
  assert.equal(state?.kind === "RETRY" && state.nextRetryAtMs, t0 + 1 * 60 * 60 * 1000);

  state = nextStateAfterOutcome(state!, "TRANSIENT_FAILURE", "2026-10-11", t0 + 1 * 60 * 60 * 1000);
  assert.equal(state?.kind === "RETRY" && state.attempts, 2);
  assert.equal(state?.kind === "RETRY" && state.nextRetryAtMs, t0 + 1 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000);

  state = nextStateAfterOutcome(state!, "TRANSIENT_FAILURE", "2026-10-11", t0 + 7 * 60 * 60 * 1000);
  assert.equal(state?.kind === "RETRY" && state.attempts, 3);
});

test("nextStateAfterOutcome: a 4th same-day failure parks retry until the start of the next calendar day", () => {
  const t0 = Date.parse("2026-10-11T00:00:00.000Z");
  let state: EtfFailureState | null = { kind: "RETRY", attempts: 3, nextRetryAtMs: t0, lastFailureDate: "2026-10-11" };
  state = nextStateAfterOutcome(state, "TRANSIENT_FAILURE", "2026-10-11", t0 + 100);
  assert.equal(state?.kind === "RETRY" && state.attempts, 4);
  assert.equal(state?.kind === "RETRY" && state.nextRetryAtMs, Date.parse("2026-10-12T00:00:00.000Z"));
});

test("nextStateAfterOutcome: a new calendar day resets the backoff sequence from attempt 1, even with a stale RETRY state from yesterday", () => {
  const yesterday: EtfFailureState = { kind: "RETRY", attempts: 4, nextRetryAtMs: Date.parse("2026-10-12T00:00:00.000Z"), lastFailureDate: "2026-10-11" };
  const state = nextStateAfterOutcome(yesterday, "TRANSIENT_FAILURE", "2026-10-12", Date.parse("2026-10-12T00:00:01.000Z"));
  assert.equal(state?.kind === "RETRY" && state.attempts, 1);
});

test("isEligibleNow: no state at all -> always eligible", () => {
  assert.equal(isEligibleNow(undefined, "2026-10-11", Date.now()), true);
});

test("isEligibleNow: SKIP_NO_PERF is ineligible until skipUntilDate, then eligible", () => {
  const state: EtfFailureState = { kind: "SKIP_NO_PERF", skipUntilDate: "2026-10-18" };
  assert.equal(isEligibleNow(state, "2026-10-17", Date.now()), false);
  assert.equal(isEligibleNow(state, "2026-10-18", Date.now()), true);
  assert.equal(isEligibleNow(state, "2026-10-19", Date.now()), true);
});

test("isEligibleNow: RETRY is ineligible before nextRetryAtMs, eligible at/after", () => {
  const state: EtfFailureState = { kind: "RETRY", attempts: 1, nextRetryAtMs: 1000, lastFailureDate: "2026-10-11" };
  assert.equal(isEligibleNow(state, "2026-10-11", 999), false);
  assert.equal(isEligibleNow(state, "2026-10-11", 1000), true);
});

test("Task X2 item B.3: orderForInvocation always puts never-attempted ETFs ahead of due-retry ETFs, so failures can never crowd out forward progress", () => {
  const stateMap: EtfFailureStateMap = {
    b: { kind: "RETRY", attempts: 1, nextRetryAtMs: 0, lastFailureDate: "2026-10-11" }, // due now
    d: { kind: "SKIP_NO_PERF", skipUntilDate: "2026-10-01" }, // past its skip date -> eligible, counts as "due"
  };
  const ordered = orderForInvocation(["d", "c", "b", "a"], stateMap, "2026-10-11", 500);
  // a, c never attempted (no entry) -> first, in id order; b, d are due-retry -> after, in id order
  assert.deepEqual(ordered, ["a", "c", "b", "d"]);
});

test("orderForInvocation: a not-yet-due RETRY/SKIP entry is excluded entirely this invocation", () => {
  const stateMap: EtfFailureStateMap = {
    a: { kind: "RETRY", attempts: 1, nextRetryAtMs: 999999, lastFailureDate: "2026-10-11" }, // not due yet
    b: { kind: "SKIP_NO_PERF", skipUntilDate: "2026-10-20" }, // not due yet
  };
  const ordered = orderForInvocation(["a", "b", "c"], stateMap, "2026-10-11", 500);
  assert.deepEqual(ordered, ["c"]);
});

console.log("FAILURE_STATE_TESTS_DONE");
