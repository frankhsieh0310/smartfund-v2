// Plain-Node focused tests (no framework, matching this repo's scripts/tests/*-focused.ts convention).
// Run with: node --experimental-strip-types lib/market-close-sync/__tests__/marketTime.test.ts
import assert from "node:assert/strict";
import { localDateFromUnix, marketCloseEligibility, pickClosedCandle } from "../marketTime.ts";
import type { ExchangeCalendarJob } from "../types.ts";

const TWSE_JOB: ExchangeCalendarJob = {
  id: "twse-yahoo-daily", market: "TWSE", exchange: "TWSE", exchanges: ["TWSE"], country: "TW",
  timezone: "Asia/Taipei", regularSession: { open: "09:00", close: "13:30" }, stabilizationDelayMinutes: 45,
  weekdays: [1, 2, 3, 4, 5], holidays: ["2026-10-09"], schedulerEnabled: true,
};

// --- Fixture sourced from this session's own real 2026-10-09 canary/Chart evidence for 9047.HK:
// Chart (authoritative) returned 5 consecutive HKT trading days with one null close; Spark SILENTLY
// DROPPED two of them (one null, one real) rather than marking them missing. Timestamps below are the
// real unix values observed (HKT midnight-session marker, 01:30 UTC = 09:30 HKT).
const HK_GAP_FIXTURE = {
  symbol: "9047.HK",
  chartDays: [
    { ts: 1791163800, close: 2.82, localDate: "2026-10-05" }, // Mon — Spark KEPT
    { ts: 1791250200, close: 2.82, localDate: "2026-10-06" }, // Tue — Spark DROPPED (non-null, real gap)
    { ts: 1791336600, close: 2.82, localDate: "2026-10-07" }, // Wed — Spark KEPT
    { ts: 1791423000, close: null, localDate: "2026-10-08" }, // Thu — null in Chart too, Spark DROPPED
    { ts: 1791509400, close: 2.736, localDate: "2026-10-09" }, // Fri — Spark KEPT
  ],
};
const HK_JOB: ExchangeCalendarJob = {
  id: "hong-kong-yahoo-daily", market: "Hong Kong", exchange: "HKG", exchanges: ["HKG"], country: "HK",
  timezone: "Asia/Hong_Kong", regularSession: { open: "09:30", close: "16:00" }, stabilizationDelayMinutes: 30,
  weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
};

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("localDateFromUnix matches the real HKT dates from the live fixture", () => {
  for (const day of HK_GAP_FIXTURE.chartDays) {
    assert.equal(localDateFromUnix(day.ts, HK_JOB.timezone), day.localDate);
  }
});

test("Spark's gap (dropping 2026-10-06, a non-null day) does NOT misalign the remaining points — pickClosedCandle finds 2026-10-07 by its own timestamp, not by array position", () => {
  // Simulate exactly what Spark actually returned for 9047.HK: only 3 of 5 days, in original order.
  // A naive "Nth day since Spark only has 3" read would misassign positions once Chart's 5-day frame
  // is the reference: Chart's 2026-10-07 is index 2 of 5, but Spark's own array only has it at index 1
  // of 3 — timestamp-based lookup must land on 2026-10-07 regardless of which index it sits at here.
  const sparkPoints = HK_GAP_FIXTURE.chartDays.filter((d) => ["2026-10-05", "2026-10-07", "2026-10-09"].includes(d.localDate))
    .map((d) => ({ timestampUnix: d.ts, close: d.close }));
  const now = new Date("2026-10-07T20:00:00+08:00"); // well after HK close+30min on the 7th
  const picked = pickClosedCandle(sparkPoints, HK_JOB, "2026-10-07", now);
  assert.ok(picked, "expected a match for 2026-10-07 despite the gap");
  assert.equal(picked!.close, 2.82);
  assert.equal(picked!.timestampUnix, 1791336600, "must be the real 2026-10-07 timestamp, not whatever sits at some assumed index");
});

test("Requesting the date Spark actually dropped (2026-10-06) returns null — SOURCE_MISSING, never backfilled from a neighboring day", () => {
  const sparkPoints = HK_GAP_FIXTURE.chartDays.filter((d) => ["2026-10-05", "2026-10-07", "2026-10-09"].includes(d.localDate))
    .map((d) => ({ timestampUnix: d.ts, close: d.close }));
  const now = new Date("2026-10-07T20:00:00+08:00");
  const picked = pickClosedCandle(sparkPoints, HK_JOB, "2026-10-06", now);
  assert.equal(picked, null);
});

test("Intraday candle (today's date, before close+delay) is discarded even though its local date matches targetLocalDate", () => {
  // Market is TWSE, close 13:30 + 45min delay = 14:15 local. "now" is 10:00 local — still open.
  const now = new Date("2026-10-08T02:00:00Z"); // 10:00 Asia/Taipei
  const todayLocal = localDateFromUnix(Math.floor(now.getTime() / 1000), TWSE_JOB.timezone);
  const points = [{ timestampUnix: Math.floor(now.getTime() / 1000), close: 123.45 }];
  const picked = pickClosedCandle(points, TWSE_JOB, todayLocal, now);
  assert.equal(picked, null, "an intraday bar must be rejected, not accepted as today's close");
});

test("The same candle IS accepted once now is past close+delay for that local date", () => {
  const closedNow = new Date("2026-10-08T06:30:00Z"); // 14:30 Asia/Taipei — past 13:30+45min
  const todayLocal = localDateFromUnix(Math.floor(closedNow.getTime() / 1000), TWSE_JOB.timezone);
  const barTs = Math.floor(new Date("2026-10-08T01:30:00Z").getTime() / 1000); // 09:30 local, during session
  const points = [{ timestampUnix: barTs, close: 123.45 }];
  const picked = pickClosedCandle(points, TWSE_JOB, todayLocal, closedNow);
  assert.ok(picked, "expected the bar to be accepted once we're past close+delay");
  assert.equal(picked!.close, 123.45);
});

test("marketCloseEligibility returns null on a configured holiday even if the clock is well past close", () => {
  const now = new Date("2026-10-09T10:00:00Z"); // 18:00 Asia/Taipei, well past close — but it's a holiday
  const result = marketCloseEligibility(TWSE_JOB, now);
  assert.equal(result, null);
});

test("marketCloseEligibility returns the target date once past close+delay on a real trading day", () => {
  const now = new Date("2026-10-08T06:30:00Z"); // 14:30 Asia/Taipei, 2026-10-08 is Thursday, not a holiday
  const result = marketCloseEligibility(TWSE_JOB, now);
  assert.ok(result);
  assert.equal(result!.targetLocalDate, "2026-10-08");
});

test("marketCloseEligibility returns null before close+delay on an otherwise-valid trading day", () => {
  const now = new Date("2026-10-08T02:00:00Z"); // 10:00 Asia/Taipei — market still open
  const result = marketCloseEligibility(TWSE_JOB, now);
  assert.equal(result, null);
});

console.log("MARKET_TIME_TESTS_DONE");
