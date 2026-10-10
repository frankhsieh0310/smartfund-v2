import assert from "node:assert/strict";
import { resolvePrice } from "../priceSource.ts";
import { localDateFromUnix } from "../marketTime.ts";
import type { ExchangeCalendarJob } from "../types.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const HK_JOB: ExchangeCalendarJob = {
  id: "hong-kong-yahoo-daily", market: "Hong Kong", exchange: "HKEX", exchanges: ["HKG"], country: "HK",
  timezone: "Asia/Hong_Kong", regularSession: { open: "09:30", close: "16:10" },
  stabilizationDelayMinutes: 45, weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
};

// 2026-10-09T08:08:06Z = 2026-10-09 16:08:06 HKT — the real, live-fetched regularMarketTime for
// 2800.HK this round, 1m54s before the job's nominal "16:10" close but inside HKEX's documented
// random Closing Auction window (16:08-16:10), hence the 16:00 override.
const REAL_2800_HK_QUOTE_TS = 1791533286;
const REAL_2800_HK_PRICE = 24.84;

test("2800.HK fixture: daily bar missing for the target date, live quote at 16:08:06 HKT resolves via QUOTE_AFTER_CLOSE at the 16:00 override boundary", () => {
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", barClose: null,
    quoteRegularMarketTimeUnix: REAL_2800_HK_QUOTE_TS, quoteRegularMarketPrice: REAL_2800_HK_PRICE,
    localDateFromUnix,
  });
  assert.deepEqual(resolved, { source: "QUOTE_AFTER_CLOSE", price: 24.84 });
});

test("2800.HK fixture: the SAME quote would NOT resolve under the job's literal (unoverridden) 16:10 close — proves the override is load-bearing, not redundant", () => {
  const jobWithoutOverride = { ...HK_JOB, id: "not-overridden-test-id" };
  const resolved = resolvePrice({
    job: jobWithoutOverride, targetLocalDate: "2026-10-09", barClose: null,
    quoteRegularMarketTimeUnix: REAL_2800_HK_QUOTE_TS, quoteRegularMarketPrice: REAL_2800_HK_PRICE,
    localDateFromUnix,
  });
  assert.equal(resolved, null);
});

test("rule 1: a non-null daily bar always wins, even when a same-day after-close quote also exists", () => {
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", barClose: 24.90,
    quoteRegularMarketTimeUnix: REAL_2800_HK_QUOTE_TS, quoteRegularMarketPrice: REAL_2800_HK_PRICE,
    localDateFromUnix,
  });
  assert.deepEqual(resolved, { source: "BAR", price: 24.90 });
});

test("rule 2 negative test: a quote timestamped BEFORE the market's close is never adopted", () => {
  // Same calendar day, but 14:00 HKT — well before even the 16:00 override, let alone 16:10.
  const beforeCloseTs = Date.UTC(2026, 9, 9, 6, 0, 0) / 1000; // 2026-10-09T06:00:00Z = 14:00 HKT
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", barClose: null,
    quoteRegularMarketTimeUnix: beforeCloseTs, quoteRegularMarketPrice: 24.5,
    localDateFromUnix,
  });
  assert.equal(resolved, null);
});

test("rule 2: a quote whose LOCAL DATE doesn't match the target date is never adopted, regardless of time-of-day", () => {
  // The quote's own timestamp lands on 2026-10-08, not the target 2026-10-09 — must not be adopted
  // as a stand-in just because its time-of-day looks like "after close".
  const wrongDayTs = Date.UTC(2026, 9, 8, 9, 0, 0) / 1000; // 2026-10-08T09:00:00Z = 17:00 HKT (after close, wrong day)
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", barClose: null,
    quoteRegularMarketTimeUnix: wrongDayTs, quoteRegularMarketPrice: 24.5,
    localDateFromUnix,
  });
  assert.equal(resolved, null);
});

test("rule 3: neither a bar nor a usable quote exists -> unresolved (null), never backfilled", () => {
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", barClose: null,
    quoteRegularMarketTimeUnix: null, quoteRegularMarketPrice: null,
    localDateFromUnix,
  });
  assert.equal(resolved, null);
});

test("France (CW8.PA): the literal configured close is used with no override — a 6-second-after-close quote still resolves (second-level precision, not minute-truncated)", () => {
  const FR_JOB: ExchangeCalendarJob = {
    id: "france-yahoo-daily", market: "France", exchange: "Euronext Paris", exchanges: ["PAR"], country: "FR",
    timezone: "Europe/Paris", regularSession: { open: "09:00", close: "17:35" },
    stabilizationDelayMinutes: 45, weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
  };
  // 2026-10-09T15:35:06Z = 2026-10-09 17:35:06 Paris — real, live-fetched CW8.PA regularMarketTime,
  // exactly 6 seconds after the configured "17:35:00" close.
  const resolved = resolvePrice({
    job: FR_JOB, targetLocalDate: "2026-10-09", barClose: null,
    quoteRegularMarketTimeUnix: 1791560106, quoteRegularMarketPrice: 715.8,
    localDateFromUnix,
  });
  assert.deepEqual(resolved, { source: "QUOTE_AFTER_CLOSE", price: 715.8 });
});

test("France (CW8.PA): the same quote one second earlier (exactly AT close) is rejected — strictly after, never at-or-after", () => {
  const FR_JOB: ExchangeCalendarJob = {
    id: "france-yahoo-daily", market: "France", exchange: "Euronext Paris", exchanges: ["PAR"], country: "FR",
    timezone: "Europe/Paris", regularSession: { open: "09:00", close: "17:35" },
    stabilizationDelayMinutes: 45, weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
  };
  const resolved = resolvePrice({
    job: FR_JOB, targetLocalDate: "2026-10-09", barClose: null,
    quoteRegularMarketTimeUnix: 1791560100, quoteRegularMarketPrice: 715.8, // 17:35:00 exactly
    localDateFromUnix,
  });
  assert.equal(resolved, null);
});

test("Germany (EUNL.DE): the 17:30 override resolves a quote the literal (unoverridden) 22:00 config close never would", () => {
  const DE_JOB: ExchangeCalendarJob = {
    id: "germany-yahoo-daily", market: "Germany", exchange: "Xetra", exchanges: ["GER"], country: "DE",
    timezone: "Europe/Berlin", regularSession: { open: "09:00", close: "22:00" },
    stabilizationDelayMinutes: 45, weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
  };
  // 2026-10-09T15:35:55Z = 17:35:55 Berlin — real, live-fetched EUNL.DE regularMarketTime.
  const resolved = resolvePrice({
    job: DE_JOB, targetLocalDate: "2026-10-09", barClose: null,
    quoteRegularMarketTimeUnix: 1791560155, quoteRegularMarketPrice: 131.64,
    localDateFromUnix,
  });
  assert.deepEqual(resolved, { source: "QUOTE_AFTER_CLOSE", price: 131.64 });
});

console.log("PRICE_SOURCE_TESTS_DONE");
