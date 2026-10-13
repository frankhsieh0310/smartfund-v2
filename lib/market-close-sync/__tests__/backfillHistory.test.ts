import assert from "node:assert/strict";
import { parseBackfillDates, computeMissingPairs, extractRequestedCloses } from "../backfillHistory.ts";

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
