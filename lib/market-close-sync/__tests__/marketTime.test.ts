// Plain-Node focused tests (no framework, matching this repo's scripts/tests/*-focused.ts convention).
// Run with: node --experimental-strip-types lib/market-close-sync/__tests__/marketTime.test.ts
import assert from "node:assert/strict";
import { localDateFromUnix, findEligibleTradeDate, pickClosedCandle } from "../marketTime.ts";
import type { ExchangeCalendarJob } from "../types.ts";

const NEVER_DONE = () => false;

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

// Task I fixture jobs — timezones/sessions are the real production values already confirmed this
// session (Japan/Shanghai read earlier; Korea's holiday list is the literal production config entry
// for korea-yahoo-daily, confirmed to include both 2026-10-05 and 2026-10-09 but NOT 10-06/07/08).
const TOKYO_JOB: ExchangeCalendarJob = {
  id: "japan-yahoo-daily", market: "Japan", exchange: "JPX", exchanges: ["JPX"], country: "JP",
  timezone: "Asia/Tokyo", regularSession: { open: "09:00", close: "15:00" }, stabilizationDelayMinutes: 30,
  weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
};
const SHANGHAI_JOB: ExchangeCalendarJob = {
  id: "shanghai-yahoo-daily", market: "Shanghai", exchange: "SHH", exchanges: ["SHH"], country: "CN",
  timezone: "Asia/Shanghai", regularSession: { open: "09:30", close: "15:00" }, stabilizationDelayMinutes: 30,
  weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
};
const KOREA_JOB: ExchangeCalendarJob = {
  id: "korea-yahoo-daily", market: "Korea", exchange: "KRX", exchanges: ["KOE", "KSC"], country: "KR",
  timezone: "Asia/Seoul", regularSession: { open: "09:00", close: "15:30" }, stabilizationDelayMinutes: 50,
  weekdays: [1, 2, 3, 4, 5],
  holidays: ["2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-02", "2026-05-01", "2026-05-05",
    "2026-05-25", "2026-08-17", "2026-09-24", "2026-09-25", "2026-09-28", "2026-10-05", "2026-10-09", "2026-12-25", "2026-12-31"],
  schedulerEnabled: true,
};
const US_JOB: ExchangeCalendarJob = {
  id: "nyse-yahoo-daily", market: "NYSE", exchange: "NYSE", exchanges: ["NYSE", "NYQ"], country: "US",
  timezone: "America/New_York", regularSession: { open: "09:30", close: "16:00" }, stabilizationDelayMinutes: 20,
  weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
};
// Generic no-holiday Mon-Fri job for the pure weekend-rollback test (timezone kept at UTC so the
// test's own date arithmetic needs no timezone conversion to reason about).
const GENERIC_UTC_JOB: ExchangeCalendarJob = {
  id: "generic-test", market: "Generic", exchange: "GEN", exchanges: [], country: "ZZ",
  timezone: "UTC", regularSession: { open: "09:00", close: "13:00" }, stabilizationDelayMinutes: 0,
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
  const now = new Date("2026-10-08T02:00:00Z"); // 10:00 Asia/Taipei — market still open
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

// --- Task I required scenarios (fixed clock, findEligibleTradeDate) ---

test("(a) 2026-10-09T16:12:00Z: Tokyo, Hong Kong, Shanghai all target 2026-10-09 and are eligible", () => {
  const now = new Date("2026-10-09T16:12:00Z");
  for (const job of [TOKYO_JOB, HK_JOB, SHANGHAI_JOB]) {
    const result = findEligibleTradeDate(job, now, NEVER_DONE);
    assert.equal(result.eligible, true, `expected ${job.market} to be eligible`);
    assert.equal((result as any).targetLocalDate, "2026-10-09", `expected ${job.market} target date 2026-10-09`);
  }
});

test("(b) Same instant: Korea has 2026-10-09 as a configured holiday — target rolls back to the prior real trading day, 2026-10-08", () => {
  const now = new Date("2026-10-09T16:12:00Z");
  const result = findEligibleTradeDate(KOREA_JOB, now, NEVER_DONE);
  assert.equal(result.eligible, true, "expected Korea to be eligible via the prior trading day");
  assert.equal((result as any).targetLocalDate, "2026-10-08");
});

test("(b-ii) Same instant, but 2026-10-08 is already marked done for Korea — nothing left in the lookback window (10-05 and 10-09 are holidays too) => not eligible, reason ALREADY_DONE", () => {
  const now = new Date("2026-10-09T16:12:00Z");
  const result = findEligibleTradeDate(KOREA_JOB, now, (d) => d <= "2026-10-08");
  assert.equal(result.eligible, false, "expected not eligible once the only real candidate in range is already done");
  assert.equal((result as any).reason, "ALREADY_DONE");
});

test("(c) Same instant: US market (still mid-session in ET) targets the prior trading day, 2026-10-08, not today", () => {
  const now = new Date("2026-10-09T16:12:00Z"); // 12:12 ET — NYSE still open
  const result = findEligibleTradeDate(US_JOB, now, NEVER_DONE);
  assert.equal(result.eligible, true, "expected the US market to still be eligible via the prior trading day");
  assert.equal((result as any).targetLocalDate, "2026-10-08");
});

test("(d) Saturday: any market rolls back to the most recent Friday", () => {
  const now = new Date("2026-10-10T12:00:00Z"); // a Saturday, UTC
  const result = findEligibleTradeDate(GENERIC_UTC_JOB, now, NEVER_DONE);
  assert.equal(result.eligible, true);
  assert.equal((result as any).targetLocalDate, "2026-10-09");
});

test("(d) Sunday: any market still rolls back to the same most recent Friday", () => {
  const now = new Date("2026-10-11T12:00:00Z"); // the following Sunday, UTC
  const result = findEligibleTradeDate(GENERIC_UTC_JOB, now, NEVER_DONE);
  assert.equal(result.eligible, true);
  assert.equal((result as any).targetLocalDate, "2026-10-09");
});

test("findEligibleTradeDate reports reason=ALREADY_DONE once the most recent eligible date is already marked done (fully caught up)", () => {
  const now = new Date("2026-10-08T06:30:00Z"); // 14:30 Asia/Taipei — past close+delay, 2026-10-08 is a real trading day
  const result = findEligibleTradeDate(TWSE_JOB, now, (d) => d <= "2026-10-08");
  assert.equal(result.eligible, false);
  assert.equal((result as any).reason, "ALREADY_DONE");
});

test("findEligibleTradeDate reports reason=NOT_YET_CLOSED when the only candidate in range is today, still before close+delay", () => {
  const now = new Date("2026-10-08T02:00:00Z"); // 10:00 Asia/Taipei — market still open, no prior day in a 1-day lookback
  const result = findEligibleTradeDate(TWSE_JOB, now, NEVER_DONE, 1);
  assert.equal(result.eligible, false);
  assert.equal((result as any).reason, "NOT_YET_CLOSED");
});

console.log("MARKET_TIME_TESTS_DONE");
