import assert from "node:assert/strict";
import { computeReturn, baseDateFor, PERFORMANCE_PERIOD_DAYS, PERFORMANCE_PERIODS } from "../performanceCalc.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("computeReturn: a simple +10% move", () => {
  assert.equal(computeReturn(110, 100), 0.1);
});

test("computeReturn: a simple -10% move", () => {
  assert.equal(computeReturn(90, 100), -0.1);
});

test("computeReturn: no base close available -> null, never fabricated as 0", () => {
  assert.equal(computeReturn(110, null), null);
});

test("computeReturn: a zero base close -> null (avoids a division-by-zero Infinity)", () => {
  assert.equal(computeReturn(110, 0), null);
});

test("baseDateFor: 1D period steps back exactly one calendar day", () => {
  assert.equal(baseDateFor("2026-10-09", PERFORMANCE_PERIOD_DAYS["1D"]), "2026-10-08");
});

test("baseDateFor: 1M period steps back 30 calendar days", () => {
  assert.equal(baseDateFor("2026-10-09", PERFORMANCE_PERIOD_DAYS["1M"]), "2026-09-09");
});

test("baseDateFor: 1Y period steps back 365 calendar days", () => {
  assert.equal(baseDateFor("2026-10-09", PERFORMANCE_PERIOD_DAYS["1Y"]), "2025-10-09");
});

test("the six required periods are exactly 1D/1M/3M/6M/1Y/3Y, per task spec — no YTD, no 5Y", () => {
  assert.deepEqual(PERFORMANCE_PERIODS, ["1D", "1M", "3M", "6M", "1Y", "3Y"]);
});

console.log("PERFORMANCE_CALC_TESTS_DONE");
