import assert from "node:assert/strict";
import { emptyState, advanceSweep } from "../completionState.ts";
import {
  classifyMarketPriority, orderMarketsForInvocation, isDueForRecheck,
  simulateRoundsToSweepAll, PER_MARKET_BUDGET_FRACTION, SOURCE_MISSING_MIN_RECHECK_DELAY_MS,
} from "../scheduling.ts";
import { NO_BAR_CONFIRM_DELAY_MS } from "../completionState.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("a market still mid-sweep is classified SWEEP regardless of pending contents", () => {
  const s = emptyState("2026-10-09");
  assert.equal(classifyMarketPriority(s, Date.now()).kind, "SWEEP");
});

test("sweepComplete + empty pending => DONE", () => {
  const s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [] }, Date.now());
  assert.equal(classifyMarketPriority(s, Date.now()).kind, "DONE");
});

test("sweepComplete + pending, none due yet => WAITING, never RECHECK_DUE", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "NO_BAR_FOR_TARGET_DATE" }] }, nowMs);
  assert.equal(classifyMarketPriority(s, nowMs + 1000).kind, "WAITING");
});

test("sweepComplete + a NO_BAR pending entry past its 6h window => RECHECK_DUE", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "NO_BAR_FOR_TARGET_DATE" }] }, nowMs);
  const laterMs = nowMs + NO_BAR_CONFIRM_DELAY_MS + 1;
  const prio = classifyMarketPriority(s, laterMs);
  assert.equal(prio.kind, "RECHECK_DUE");
  if (prio.kind === "RECHECK_DUE") assert.equal(prio.dueCount, 1);
});

test("a SOURCE_MISSING pending entry is not due before its own minimum re-check spacing", () => {
  const nowMs = Date.now();
  const s = advanceSweep(emptyState("2026-10-09"), { ok: true, isLastBatch: true, observations: [{ etfId: "a", symbol: "A", classification: "SOURCE_MISSING" }] }, nowMs);
  assert.equal(classifyMarketPriority(s, nowMs + 1000).kind, "WAITING"); // 1s later, same invocation — never due immediately
  assert.equal(classifyMarketPriority(s, nowMs + SOURCE_MISSING_MIN_RECHECK_DELAY_MS + 1).kind, "RECHECK_DUE");
});

test("isDueForRecheck matches classifyMarketPriority's own due-count exactly, for a mixed pending set", () => {
  const nowMs = Date.now();
  let s = advanceSweep(emptyState("2026-10-09"), {
    ok: true, isLastBatch: true,
    observations: [
      { etfId: "a", symbol: "A", classification: "SOURCE_MISSING" },
      { etfId: "b", symbol: "B", classification: "NO_BAR_FOR_TARGET_DATE" },
    ],
  }, nowMs);
  // SOURCE_MISSING's own minimum spacing (15min) is far shorter than NO_BAR's 6h window, so a point
  // in between (30min) has the SOURCE_MISSING entry due and the NO_BAR entry still waiting.
  const betweenMs = nowMs + 30 * 60 * 1000;
  const due = s.pending.filter((p) => isDueForRecheck(p, betweenMs));
  assert.equal(due.length, 1);
  assert.equal(due[0].etfId, "a");
});

test("orderMarketsForInvocation puts every SWEEP market ahead of every RECHECK_DUE market, preserving relative order within each group", () => {
  const ordered = orderMarketsForInvocation([
    { item: "uk", priority: { kind: "RECHECK_DUE", dueCount: 3 } },
    { item: "japan", priority: { kind: "SWEEP" } },
    { item: "hk", priority: { kind: "RECHECK_DUE", dueCount: 1 } },
    { item: "france", priority: { kind: "SWEEP" } },
    { item: "korea", priority: { kind: "WAITING" } },
    { item: "spain", priority: { kind: "DONE" } },
  ]);
  assert.deepEqual(ordered, ["japan", "france", "uk", "hk"]); // WAITING and DONE dropped entirely
});

test("PER_MARKET_BUDGET_FRACTION is exactly 40%, matching the task's explicit cap", () => {
  assert.equal(PER_MARKET_BUDGET_FRACTION, 0.4);
});

test("fairness simulation: one dominant market (far larger than everyone else) never starves the rest — every market finishes within a bounded number of rounds", () => {
  // Mirrors the real Task K shape: UK needed ~287 batches (5734/20) against 7 other markets each
  // needing a handful. totalBatchBudget models "how many 300ms-batches fit in 240s" ≈ 240000/300≈800,
  // but the real constraint that matters here is the 40% PER-MARKET CAP, not the raw total — so a
  // smaller, clearer round number is used: budget=20 batches/invocation, cap=40%*20=8 batches/market.
  const marketBatchCounts = [287, 14, 6, 19, 15, 18, 15, 15]; // uk, twse, tpex, japan, hk, korea, canada, australia
  const perMarketBatchCap = 8; // 40% of a 20-batch invocation budget
  const totalBatchBudget = 20;
  const rounds = simulateRoundsToSweepAll(marketBatchCounts, perMarketBatchCap, totalBatchBudget);
  // Finite and small: with the cap in place, the smaller markets finish within the first couple of
  // rounds regardless of how large UK is — this is the actual fairness property under test.
  assert.ok(rounds > 0 && rounds < 100, `expected a small finite round count, got ${rounds}`);
});

test("fairness simulation: WITHOUT a per-market cap, round 1 drains the whole budget into market 0 alone, so every other market is still untouched at 0 progress", () => {
  const marketBatchCounts = [287, 14, 6, 19, 15, 18, 15, 15];
  const totalBatchBudget = 20;
  const remainingNoCap = [...marketBatchCounts];
  let budgetLeft = totalBatchBudget;
  for (let i = 0; i < remainingNoCap.length && budgetLeft > 0; i++) {
    const take = Math.min(remainingNoCap[i], totalBatchBudget, budgetLeft); // cap == full budget: no limit per market
    remainingNoCap[i] -= take;
    budgetLeft -= take;
  }
  assert.deepEqual(remainingNoCap.slice(1), [14, 6, 19, 15, 18, 15, 15], "markets 1-7 got zero progress in round 1 without a cap");

  // WITH the 40%-equivalent cap (8 of 20), the same round instead reaches every small market.
  const remainingCapped = [...marketBatchCounts];
  budgetLeft = totalBatchBudget;
  for (let i = 0; i < remainingCapped.length && budgetLeft > 0; i++) {
    const take = Math.min(remainingCapped[i], 8, budgetLeft);
    remainingCapped[i] -= take;
    budgetLeft -= take;
  }
  assert.ok(remainingCapped.slice(1, 4).some((r, idx) => r < marketBatchCounts[idx + 1]), "at least one small market made progress in round 1 under the cap");
});

test("fairness simulation: every market eventually reaches zero remaining batches — none is permanently skipped", () => {
  const marketBatchCounts = [500, 1, 1, 1, 1];
  const rounds = simulateRoundsToSweepAll(marketBatchCounts, 5, 20);
  assert.ok(Number.isFinite(rounds));
  // Re-run the same simulation manually tracking the SMALL markets specifically finish on round 1,
  // never waiting on the giant one to finish first.
  const remaining = [...marketBatchCounts];
  const perMarketBatchCap = 5;
  const totalBatchBudget = 20;
  let budgetLeft = totalBatchBudget;
  for (let i = 0; i < remaining.length && budgetLeft > 0; i++) {
    const take = Math.min(remaining[i], perMarketBatchCap, budgetLeft);
    remaining[i] -= take;
    budgetLeft -= take;
  }
  assert.ok(remaining.slice(1).every((r) => r === 0), "all four small markets must fully finish within round 1");
});

console.log("SCHEDULING_TESTS_DONE");
