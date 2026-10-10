import assert from "node:assert/strict";
import { resolvePrice } from "../priceSource.ts";
import { localDateFromUnix, isDefinitelyClosed } from "../marketTime.ts";
import type { ExchangeCalendarJob } from "../types.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const HK_JOB: ExchangeCalendarJob = {
  id: "hong-kong-yahoo-daily", market: "Hong Kong", exchange: "HKEX", exchanges: ["HKG"], country: "HK",
  timezone: "Asia/Hong_Kong", regularSession: { open: "09:30", close: "16:10" },
  stabilizationDelayMinutes: 45, weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
};

function helpers() {
  return { localDateFromUnix, isDefinitelyClosed };
}

// Task N's own worked fixture: last trade at 14:30 HKT on the target date (2026-10-09).
// 2026-10-09T06:30:00Z = 14:30:00 HKT.
const LAST_TRADE_1430_TS = Date.UTC(2026, 9, 9, 6, 30, 0) / 1000;
const LAST_TRADE_PRICE = 24.5;

test("rule 2: last trade at 14:30 (same day), checked AFTER close+delay -> adopted as QUOTE_FINAL", () => {
  // now = 2026-10-09T09:00:00Z = 17:00 HKT, well past close(16:10)+delay(45min)=16:55.
  const now = new Date(Date.UTC(2026, 9, 9, 9, 0, 0));
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", now, barClose: null,
    quoteRegularMarketTimeUnix: LAST_TRADE_1430_TS, quoteRegularMarketPrice: LAST_TRADE_PRICE,
    ...helpers(),
  });
  assert.deepEqual(resolved, { kind: "RESOLVED", source: "QUOTE_FINAL", price: 24.5 });
});

test("rule 2: the SAME last-trade-at-14:30 quote, checked BEFORE close+delay -> NOT adopted (unresolved)", () => {
  // now = 2026-10-09T07:00:00Z = 15:00 HKT, still before close(16:10)+delay(45min)=16:55.
  const now = new Date(Date.UTC(2026, 9, 9, 7, 0, 0));
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", now, barClose: null,
    quoteRegularMarketTimeUnix: LAST_TRADE_1430_TS, quoteRegularMarketPrice: LAST_TRADE_PRICE,
    ...helpers(),
  });
  assert.deepEqual(resolved, { kind: "UNRESOLVED" });
});

test("rule 3: checked after close+delay, but the quote's own local date is EARLIER than target -> NO_TRADE_ON_TARGET", () => {
  // now = 2026-10-10T09:00:00Z = 17:00 HKT on the 10th, well past the 9th's close+delay.
  const now = new Date(Date.UTC(2026, 9, 10, 9, 0, 0));
  // The quote itself is still dated the 8th (2026-10-08T07:00:00Z = 15:00 HKT 10/8) — nothing traded
  // on the 9th at all.
  const staleQuoteTs = Date.UTC(2026, 9, 8, 7, 0, 0) / 1000;
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", now, barClose: null,
    quoteRegularMarketTimeUnix: staleQuoteTs, quoteRegularMarketPrice: 24.0,
    ...helpers(),
  });
  assert.deepEqual(resolved, { kind: "NO_TRADE_ON_TARGET" });
});

test("rule 1: a non-null daily bar always wins, even past close+delay with a same-day quote also present", () => {
  const now = new Date(Date.UTC(2026, 9, 9, 9, 0, 0));
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", now, barClose: 24.90,
    quoteRegularMarketTimeUnix: LAST_TRADE_1430_TS, quoteRegularMarketPrice: LAST_TRADE_PRICE,
    ...helpers(),
  });
  assert.deepEqual(resolved, { kind: "RESOLVED", source: "BAR", price: 24.90 });
});

test("rule 4: no quote at all, past close+delay -> stays unresolved, never guessed", () => {
  const now = new Date(Date.UTC(2026, 9, 9, 9, 0, 0));
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", now, barClose: null,
    quoteRegularMarketTimeUnix: null, quoteRegularMarketPrice: null,
    ...helpers(),
  });
  assert.deepEqual(resolved, { kind: "UNRESOLVED" });
});

test("rule 4: a quote dated AFTER the target date says nothing about the target day -> stays unresolved, not NO_TRADE_ON_TARGET", () => {
  const now = new Date(Date.UTC(2026, 9, 10, 9, 0, 0));
  // Quote dated the 10th while we're asking about the 9th.
  const futureQuoteTs = Date.UTC(2026, 9, 10, 7, 0, 0) / 1000;
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", now, barClose: null,
    quoteRegularMarketTimeUnix: futureQuoteTs, quoteRegularMarketPrice: 25.0,
    ...helpers(),
  });
  assert.deepEqual(resolved, { kind: "UNRESOLVED" });
});

test("rule 2/3 gate: before close+delay, even a quote dated strictly earlier than target is NOT yet declared NO_TRADE_ON_TARGET", () => {
  // now still before close+delay on the target date itself (same-day early check).
  const now = new Date(Date.UTC(2026, 9, 9, 7, 0, 0)); // 15:00 HKT, before 16:55 close+delay
  const staleQuoteTs = Date.UTC(2026, 9, 8, 7, 0, 0) / 1000;
  const resolved = resolvePrice({
    job: HK_JOB, targetLocalDate: "2026-10-09", now, barClose: null,
    quoteRegularMarketTimeUnix: staleQuoteTs, quoteRegularMarketPrice: 24.0,
    ...helpers(),
  });
  assert.deepEqual(resolved, { kind: "UNRESOLVED" });
});

console.log("PRICE_SOURCE_TESTS_DONE");
