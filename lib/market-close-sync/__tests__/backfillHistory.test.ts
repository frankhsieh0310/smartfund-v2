import assert from "node:assert/strict";
import { parseBackfillDates, computeMissingPairs, extractRequestedCloses, filterTradingDates, computeConfirmedNoData } from "../backfillHistory.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("parseBackfillDates: unset/empty -> empty array (no-op)", () => {
  assert.deepEqual(parseBackfillDates(undefined), []);
  assert.deepEqual(parseBackfillDates(""), []);
});

test("parseBackfillDates: comma-separated dates, deduped and sorted", () => {
  assert.deepEqual(parseBackfillDates("2026-10-09,2026-10-07,2026-10-07, 2026-10-08 "), ["2026-10-07", "2026-10-08", "2026-10-09"]);
});

test("parseBackfillDates: malformed entries are dropped, not crashed on", () => {
  assert.deepEqual(parseBackfillDates("2026-10-07,not-a-date,2026/10/08,"), ["2026-10-07"]);
});

test("computeMissingPairs: only pairs absent from existingPairs are returned", () => {
  const result = computeMissingPairs(["e1", "e2"], ["2026-10-07", "2026-10-08"], new Set(["e1::2026-10-07"]));
  assert.deepEqual(result, [
    { etfId: "e1", date: "2026-10-08" },
    { etfId: "e2", date: "2026-10-07" },
    { etfId: "e2", date: "2026-10-08" },
  ]);
});

test("computeMissingPairs: everything already present -> empty", () => {
  const existing = new Set(["e1::2026-10-07", "e1::2026-10-08"]);
  assert.deepEqual(computeMissingPairs(["e1"], ["2026-10-07", "2026-10-08"], existing), []);
});

test("computeMissingPairs: empty candidates or empty dates -> empty", () => {
  assert.deepEqual(computeMissingPairs([], ["2026-10-07"], new Set()), []);
  assert.deepEqual(computeMissingPairs(["e1"], [], new Set()), []);
});

test("extractRequestedCloses: only requested dates are returned, others ignored", () => {
  const points = [
    { dateKey: "2026-10-06", close: 10 },
    { dateKey: "2026-10-07", close: 11 },
    { dateKey: "2026-10-08", close: 12 },
  ];
  const result = extractRequestedCloses(points, ["2026-10-07"]);
  assert.deepEqual([...result.entries()], [["2026-10-07", 11]]);
});

test("extractRequestedCloses: a null close (genuine no-trade day per Yahoo) is never included", () => {
  const points = [{ dateKey: "2026-10-07", close: null }];
  const result = extractRequestedCloses(points, ["2026-10-07"]);
  assert.equal(result.size, 0);
});

test("extractRequestedCloses: duplicate dateKeys keep the LAST occurrence (same convention as dividend-sync dedup)", () => {
  const points = [
    { dateKey: "2026-10-07", close: 11 },
    { dateKey: "2026-10-07", close: 11.5 },
  ];
  const result = extractRequestedCloses(points, ["2026-10-07"]);
  assert.equal(result.get("2026-10-07"), 11.5);
});

// Regression case: 2026-10-09/10/11 (Fri bridge holiday / Sat / Sun around Taiwan's 國慶日) have zero
// Yahoo data for 0050.TW -- a non-trading-day gap must never be counted as missing, or alreadyComplete
// can never become true and the temporary cron (vercel.json) never stops.
test("filterTradingDates: a weekend/holiday with no 0050.TW data is dropped entirely", () => {
  const tradingDays = new Set(["2026-10-07", "2026-10-08", "2026-10-12", "2026-10-13"]); // 09/10/11 absent
  const result = filterTradingDates(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"], tradingDays);
  assert.deepEqual(result, ["2026-10-07", "2026-10-08", "2026-10-12", "2026-10-13"]);
});

test("filterTradingDates: empty trading-day set drops everything (market calendar fetch failed -- safer to backfill nothing than guess)", () => {
  assert.deepEqual(filterTradingDates(["2026-10-07", "2026-10-08"], new Set()), []);
});

test("computeMissingPairs: a confirmed-no-data pair is excluded even though it's not in existingPairs either", () => {
  const result = computeMissingPairs(["e1", "e2"], ["2026-10-07"], new Set(), new Set(["e1::2026-10-07"]));
  assert.deepEqual(result, [{ etfId: "e2", date: "2026-10-07" }]);
});

test("computeMissingPairs: confirmedNoData defaults to empty when omitted (back-compat)", () => {
  const result = computeMissingPairs(["e1"], ["2026-10-07"], new Set());
  assert.deepEqual(result, [{ etfId: "e1", date: "2026-10-07" }]);
});

// Regression case: 00838B.TWO returns "No data found, symbol may be delisted" from Yahoo -- every
// requested date for it must be recorded as confirmed-no-data, not silently skipped forever unresolved.
test("computeConfirmedNoData: every requested date missing from closes (delisted symbol) is reported", () => {
  const result = computeConfirmedNoData(["2026-10-07", "2026-10-08"], new Map());
  assert.deepEqual(result, ["2026-10-07", "2026-10-08"]);
});

test("computeConfirmedNoData: a date Yahoo DID return a close for is not reported", () => {
  const result = computeConfirmedNoData(["2026-10-07", "2026-10-08"], new Map([["2026-10-07", 42]]));
  assert.deepEqual(result, ["2026-10-08"]);
});

test("computeConfirmedNoData: every requested date resolved -> empty", () => {
  const result = computeConfirmedNoData(["2026-10-07"], new Map([["2026-10-07", 42]]));
  assert.deepEqual(result, []);
});

// End-to-end-ish: once every trading-day pair is either written or confirmed-no-data, nothing is left
// missing -- this is the condition the route's alreadyComplete must reach.
test("computeMissingPairs: all pairs resolved via existing+confirmedNoData combined -> empty (alreadyComplete reachable)", () => {
  const existingPairs = new Set(["e1::2026-10-07"]);
  const confirmedNoData = new Set(["e1::2026-10-08", "e2::2026-10-07", "e2::2026-10-08"]);
  const result = computeMissingPairs(["e1", "e2"], ["2026-10-07", "2026-10-08"], existingPairs, confirmedNoData);
  assert.deepEqual(result, []);
});
