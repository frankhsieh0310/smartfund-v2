import assert from "node:assert/strict";
import { isCoreUniverseMember, isCoreUniverseMemberFromCounts, isHongKongCurrencyCounter, activityMeasureForDataSource } from "../coreUniverse.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const T = (n: number) => Array.from({ length: n }, () => ({ tradedPositive: true }));
const F = (n: number) => Array.from({ length: n }, () => ({ tradedPositive: false }));

test("established listing (20+ rows): exactly 15/20 active passes", () => {
  assert.equal(isCoreUniverseMember([...T(15), ...F(5)]), true);
});

test("established listing: 14/20 active fails", () => {
  assert.equal(isCoreUniverseMember([...T(14), ...F(6)]), false);
});

test("established listing: only the most recent 20 rows count, even if more are passed in", () => {
  // 30 rows total: first 20 (most-recent) have 14 active -> fails, even though rows 21-30 are all active.
  const days = [...T(14), ...F(6), ...T(10)];
  assert.equal(isCoreUniverseMember(days), false);
});

test("new listing (< 20 rows): exactly 75% active passes (3/4)", () => {
  assert.equal(isCoreUniverseMember([...T(3), ...F(1)]), true);
});

test("new listing: below 75% fails (2/4 = 50%)", () => {
  assert.equal(isCoreUniverseMember([...T(2), ...F(2)]), false);
});

test("new listing: a single active day out of one available day passes (1/1 = 100%)", () => {
  assert.equal(isCoreUniverseMember([{ tradedPositive: true }]), true);
});

test("no history at all: excluded", () => {
  assert.equal(isCoreUniverseMember([]), false);
});

test("00631L.TW / 0050.TW / SPY / VOO equivalent: 20/20 active -> included", () => {
  assert.equal(isCoreUniverseMember(T(20)), true);
});

test("Hong Kong currency counters are excluded by the -U/-R.HK suffix pattern, case-insensitively", () => {
  assert.equal(isHongKongCurrencyCounter("02800-U.HK"), true);
  assert.equal(isHongKongCurrencyCounter("03010-R.HK"), true);
  assert.equal(isHongKongCurrencyCounter("02800-u.hk"), true);
});

test("Hong Kong currency counter exclusion does NOT fire on an ordinary HK code, even one ending in U or R", () => {
  assert.equal(isHongKongCurrencyCounter("2800.HK"), false);
  assert.equal(isHongKongCurrencyCounter("09988.HK"), false);
  // A hyphen not immediately followed by U/R before .HK must not match.
  assert.equal(isHongKongCurrencyCounter("2800-X.HK"), false);
});

test("Hong Kong currency counter exclusion never fires outside .HK, even with the same -U/-R shape", () => {
  assert.equal(isHongKongCurrencyCounter("SOME-U.TO"), false);
  assert.equal(isHongKongCurrencyCounter("SOME-R.L"), false);
});

test("activity measure: Vienna/.VI and Dusseldorf/.DU and Frankfurt/.F use the close-based substitute", () => {
  assert.equal(activityMeasureForDataSource("AM73.VI"), "close");
  assert.equal(activityMeasureForDataSource("ABC.DU"), "close");
  assert.equal(activityMeasureForDataSource("XYZ.F"), "close");
});

test("activity measure: every other suffix, and no-suffix US tickers, default to volume", () => {
  assert.equal(activityMeasureForDataSource("0050.TW"), "volume");
  assert.equal(activityMeasureForDataSource("SPY"), "volume");
  assert.equal(activityMeasureForDataSource("VOO"), "volume");
  assert.equal(activityMeasureForDataSource("2800.HK"), "volume");
});

test("isCoreUniverseMemberFromCounts agrees with isCoreUniverseMember on every case above", () => {
  assert.equal(isCoreUniverseMemberFromCounts(20, 15), true);
  assert.equal(isCoreUniverseMemberFromCounts(20, 14), false);
  assert.equal(isCoreUniverseMemberFromCounts(4, 3), true);
  assert.equal(isCoreUniverseMemberFromCounts(4, 2), false);
  assert.equal(isCoreUniverseMemberFromCounts(1, 1), true);
  assert.equal(isCoreUniverseMemberFromCounts(0, 0), false);
});

console.log("CORE_UNIVERSE_TESTS_DONE");
