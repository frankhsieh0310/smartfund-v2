import assert from "node:assert/strict";
import { emptyState, advanceSweep, isMarketDone, computeDbGapIds, NO_BAR_CONFIRM_DELAY_MS } from "../completionState.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("a FINAL classification (NEW) completes the market as soon as the sweep's last batch says so", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "NEW" }] }, nowMs);
  assert.equal(isMarketDone(s), true);
});

test("Task N: NO_TRADE_ON_TARGET is final the first time it's observed, same as NEW/CHANGED/SAME/DB_NEWER", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "NO_TRADE_ON_TARGET" }] }, nowMs);
  assert.equal(isMarketDone(s), true);
  assert.equal(s.pending.length, 0);
});

test("Task O: UNIT_MISMATCH and PRICE_JUMP_REVIEW are both final the first time, never re-checked", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), {
    ok: true, isLastBatch: true,
    observations: [
      { etfId: "a", symbol: "A", classification: "UNIT_MISMATCH" },
      { etfId: "b", symbol: "B", classification: "PRICE_JUMP_REVIEW" },
    ],
  }, nowMs);
  assert.equal(isMarketDone(s), true);
  assert.equal(s.pending.length, 0);
});

test("Task P: DB_DISCONTINUITY is also final the first time", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "DB_DISCONTINUITY" }] }, nowMs);
  assert.equal(isMarketDone(s), true);
  assert.equal(s.pending.length, 0);
});

test("a market is NOT done while the sweep itself hasn't reached its last batch, even with zero pending", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: false, observations: [{ etfId: "a", symbol: "A", classification: "SAME" }] }, nowMs);
  assert.equal(isMarketDone(s), false);
});

test("SOURCE_MISSING: one observation only starts the pending clock — market not done yet", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "SOURCE_MISSING" }] }, nowMs);
  assert.equal(isMarketDone(s), false);
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].state, "SOURCE_MISSING_PENDING");
});

test("SOURCE_MISSING: a SECOND separate observation confirms it final and completes the market", () => {
  const nowMs = Date.now();
  let s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "SOURCE_MISSING" }] }, nowMs);
  s = advanceSweep(s, { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "SOURCE_MISSING" }] }, nowMs + 1000);
  assert.equal(isMarketDone(s), true);
  assert.equal(s.pending.length, 0);
});

test("NO_BAR_FOR_TARGET_DATE: not final within the 6h cooling-off window, even on re-check", () => {
  const nowMs = Date.now();
  let s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "NO_BAR_FOR_TARGET_DATE" }] }, nowMs);
  s = advanceSweep(s, { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "NO_BAR_FOR_TARGET_DATE" }] }, nowMs + 3 * 60 * 60 * 1000);
  assert.equal(isMarketDone(s), false);
  assert.equal(s.pending[0].firstSeenAtMs, nowMs); // original first-seen time preserved, not reset by the re-check
});

test("NO_BAR_FOR_TARGET_DATE: becomes final once re-observed past the 6h window", () => {
  const nowMs = Date.now();
  let s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "NO_BAR_FOR_TARGET_DATE" }] }, nowMs);
  s = advanceSweep(s, { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "NO_BAR_FOR_TARGET_DATE" }] }, nowMs + NO_BAR_CONFIRM_DELAY_MS + 1);
  assert.equal(isMarketDone(s), true);
});

test("a fetch error is a strict no-op: state is returned unchanged, market stays not-done", () => {
  const nowMs = Date.now();
  const s0 = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: false, observations: [{ etfId: "a", symbol: "A", classification: "SAME" }] }, nowMs);
  const s1 = advanceSweep(s0, { ok: false }, nowMs + 1000);
  assert.deepEqual(s1, s0);
  assert.equal(isMarketDone(s1), false);
});

test("a fetch error partway through a sweep must not let the market complete just because nothing is pending yet", () => {
  const nowMs = Date.now();
  let s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: false, observations: [{ etfId: "a", symbol: "A", classification: "SAME" }] }, nowMs);
  s = advanceSweep(s, { ok: false }, nowMs); // this batch's candidates are simply never classified
  assert.equal(s.pending.length, 0); // nothing pending...
  assert.equal(isMarketDone(s), false); // ...but still not done, because sweepComplete never became true
});

test("mixed market: market only completes once EVERY ETF (final + both confirmed-pending) clears", () => {
  const nowMs = Date.now();
  let s = advanceSweep(emptyState("2026-10-09"), {
    ok: true, isLastBatch: true,
    observations: [
      { etfId: "a", symbol: "A", classification: "SAME" },
      { etfId: "b", symbol: "B", classification: "SOURCE_MISSING" },
      { etfId: "c", symbol: "C", classification: "NO_BAR_FOR_TARGET_DATE" },
    ],
  }, nowMs);
  assert.equal(isMarketDone(s), false);
  assert.equal(s.pending.length, 2);
  s = advanceSweep(s, { ok: true, isLastBatch: true, observations: [{ etfId: "b", symbol: "B", classification: "SOURCE_MISSING" }] }, nowMs + 1000);
  assert.equal(isMarketDone(s), false); // c still pending
  s = advanceSweep(s, { ok: true, isLastBatch: true, observations: [{ etfId: "c", symbol: "C", classification: "NO_BAR_FOR_TARGET_DATE" }] }, nowMs + NO_BAR_CONFIRM_DELAY_MS + 1);
  assert.equal(isMarketDone(s), true);
});

test("Task W4: SOURCE_MISSING/NO_TRADE_ON_TARGET/UNIT_MISMATCH/PRICE_JUMP_REVIEW are tracked in terminalNonWrite once final; NEW/CHANGED/SAME/DB_NEWER/DB_DISCONTINUITY are not", () => {
  const nowMs = Date.now();
  let s = advanceSweep(emptyState("2026-10-09"), {
    ok: true, isLastBatch: false,
    observations: [
      { etfId: "a", symbol: "A", classification: "SOURCE_MISSING" }, // pending (1st observation)
      { etfId: "b", symbol: "B", classification: "NO_TRADE_ON_TARGET" },
      { etfId: "c", symbol: "C", classification: "UNIT_MISMATCH" },
      { etfId: "d", symbol: "D", classification: "PRICE_JUMP_REVIEW" },
      { etfId: "e", symbol: "E", classification: "NEW" },
      { etfId: "f", symbol: "F", classification: "SAME" },
      { etfId: "g", symbol: "G", classification: "DB_DISCONTINUITY" },
    ],
  }, nowMs);
  assert.deepEqual(s.terminalNonWrite, { b: "NO_TRADE_ON_TARGET", c: "UNIT_MISMATCH", d: "PRICE_JUMP_REVIEW" });
  // confirm SOURCE_MISSING on a separate later pass -> now terminal-non-write too
  s = advanceSweep(s, { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "SOURCE_MISSING" }] }, nowMs + 1000);
  assert.deepEqual(s.terminalNonWrite, { a: "SOURCE_MISSING", b: "NO_TRADE_ON_TARGET", c: "UNIT_MISMATCH", d: "PRICE_JUMP_REVIEW" });
});

test("Task W4: computeDbGapIds — missing from both the DB and terminalNonWrite is a real gap; present in either is not", () => {
  const core = ["a", "b", "c", "d"];
  const dbPresent = new Set(["a"]);
  const terminalNonWrite = { b: "SOURCE_MISSING" as const };
  assert.deepEqual(computeDbGapIds(core, dbPresent, terminalNonWrite), ["c", "d"]);
});

test("Task W4: the exact scenario this task fixes — checkpoint says done (sweepComplete, no pending), but the DB is missing a row for one core-universe ETF that classified NEW — computeDbGapIds must still report it as missing", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), {
    ok: true, isLastBatch: true,
    observations: [
      { etfId: "a", symbol: "A", classification: "SAME" }, // DB already has this one
      { etfId: "b", symbol: "B", classification: "NEW" },  // shadow mode: classified NEW but NEVER written
    ],
  }, nowMs);
  // Old rule: isMarketDone(s) alone would say "done" — sweepComplete true, pending empty.
  assert.equal(isMarketDone(s), true);
  // New rule: the DB only actually has "a" (shadow mode never wrote "b"'s NEW classification), and
  // "b" is not in terminalNonWrite (NEW is deliberately excluded) — so it must still show as a gap,
  // meaning route.ts's gap-reverify must keep this market open and reprocess "b" rather than trusting
  // isMarketDone and advancing lastDoneDate.
  const dbPresent = new Set(["a"]); // "b" was never written — shadow mode
  const gap = computeDbGapIds(["a", "b"], dbPresent, s.terminalNonWrite);
  assert.deepEqual(gap, ["b"]);
});

test("Task W4: once write mode actually writes the NEW ETF's row, the same gap check reports it as resolved", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), {
    ok: true, isLastBatch: true,
    observations: [{ etfId: "b", symbol: "B", classification: "NEW" }],
  }, nowMs);
  const dbPresentAfterWrite = new Set(["b"]); // write mode actually wrote it this time
  const gap = computeDbGapIds(["b"], dbPresentAfterWrite, s.terminalNonWrite);
  assert.deepEqual(gap, []);
});

console.log("COMPLETION_STATE_TESTS_DONE");
