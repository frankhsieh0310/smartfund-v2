import assert from "node:assert/strict";
import { nextStateAfterOutcome, isEligibleNow, orderForInvocation, type FundFailureStateMap } from "../failureState.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
  return p;
}

(async () => {
  test("nextStateAfterOutcome: SUCCESS always clears any prior state", () => {
    assert.equal(nextStateAfterOutcome({ kind: "SKIP_NO_DATA", skipUntilDate: "2026-10-20" }, "SUCCESS", "2026-10-11", Date.now()), null);
  });

  test("nextStateAfterOutcome: NO_DATA sets a 7-day skip from today", () => {
    const r = nextStateAfterOutcome(undefined, "NO_DATA", "2026-10-11", Date.now());
    assert.deepEqual(r, { kind: "SKIP_NO_DATA", skipUntilDate: "2026-10-18" });
  });

  test("nextStateAfterOutcome: 1h -> 6h -> 24h backoff across same-day retries", () => {
    const now = Date.now();
    const a1 = nextStateAfterOutcome(undefined, "TRANSIENT_FAILURE", "2026-10-11", now);
    assert.equal(a1?.kind, "RETRY");
    assert.equal((a1 as any).attempts, 1);
    assert.ok(Math.abs((a1 as any).nextRetryAtMs - (now + 1 * 3600_000)) < 5000);

    const a2 = nextStateAfterOutcome(a1!, "TRANSIENT_FAILURE", "2026-10-11", now);
    assert.equal((a2 as any).attempts, 2);
    assert.ok(Math.abs((a2 as any).nextRetryAtMs - (now + 6 * 3600_000)) < 5000);

    const a3 = nextStateAfterOutcome(a2!, "TRANSIENT_FAILURE", "2026-10-11", now);
    assert.equal((a3 as any).attempts, 3);
    assert.ok(Math.abs((a3 as any).nextRetryAtMs - (now + 24 * 3600_000)) < 5000);
  });

  test("nextStateAfterOutcome: a 4th same-day failure parks until the start of the next calendar day", () => {
    const now = Date.now();
    let state = nextStateAfterOutcome(undefined, "TRANSIENT_FAILURE", "2026-10-11", now)!;
    state = nextStateAfterOutcome(state, "TRANSIENT_FAILURE", "2026-10-11", now)!;
    state = nextStateAfterOutcome(state, "TRANSIENT_FAILURE", "2026-10-11", now)!;
    const fourth = nextStateAfterOutcome(state, "TRANSIENT_FAILURE", "2026-10-11", now)!;
    assert.equal((fourth as any).nextRetryAtMs, new Date("2026-10-12T00:00:00Z").getTime());
  });

  test("nextStateAfterOutcome: a new calendar day resets the backoff sequence from attempt 1", () => {
    const stale = { kind: "RETRY" as const, attempts: 3, nextRetryAtMs: 0, lastFailureDate: "2026-10-10" };
    const r = nextStateAfterOutcome(stale, "TRANSIENT_FAILURE", "2026-10-11", Date.now());
    assert.equal((r as any).attempts, 1);
  });

  test("isEligibleNow: no state -> always eligible", () => {
    assert.equal(isEligibleNow(undefined, "2026-10-11", Date.now()), true);
  });

  test("isEligibleNow: SKIP_NO_DATA ineligible until skipUntilDate, eligible after", () => {
    const s = { kind: "SKIP_NO_DATA" as const, skipUntilDate: "2026-10-18" };
    assert.equal(isEligibleNow(s, "2026-10-17", Date.now()), false);
    assert.equal(isEligibleNow(s, "2026-10-18", Date.now()), true);
  });

  test("isEligibleNow: RETRY ineligible before nextRetryAtMs, eligible at/after", () => {
    const s = { kind: "RETRY" as const, attempts: 1, nextRetryAtMs: 1000, lastFailureDate: "2026-10-11" };
    assert.equal(isEligibleNow(s, "2026-10-11", 999), false);
    assert.equal(isEligibleNow(s, "2026-10-11", 1000), true);
  });

  test("orderForInvocation: never-attempted ids always come before due-retry ids", () => {
    const map: FundFailureStateMap = { b: { kind: "RETRY", attempts: 1, nextRetryAtMs: 0, lastFailureDate: "2026-10-10" } };
    const result = orderForInvocation(["b", "a"], map, "2026-10-11", 5000);
    assert.deepEqual(result, ["a", "b"]);
  });

  test("orderForInvocation: a not-yet-due entry is excluded entirely this invocation", () => {
    const map: FundFailureStateMap = { a: { kind: "SKIP_NO_DATA", skipUntilDate: "2026-10-20" } };
    const result = orderForInvocation(["a", "b"], map, "2026-10-11", Date.now());
    assert.deepEqual(result, ["b"]);
  });
})();
