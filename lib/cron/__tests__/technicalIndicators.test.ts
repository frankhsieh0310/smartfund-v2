import assert from "node:assert/strict";
import { sma, ema, macd, rsi, bollinger, kd, nDayHighLow, volumeMultiple } from "../technicalIndicators.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("sma: plain average of the last N closes, ignores anything before the window", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), (3 + 4 + 5) / 3);
});

test("sma: null when fewer points than the period", () => {
  assert.equal(sma([1, 2], 3), null);
});

test("ema: seeded with a leading SMA(period), matches hand-computed 3-period EMA on [1,2,3,4,5]", () => {
  // seed = SMA(3) of [1,2,3] = 2; k = 2/(3+1) = 0.5
  // step i=3 (value 4): 4*0.5 + 2*0.5 = 3
  // step i=4 (value 5): 5*0.5 + 3*0.5 = 4
  assert.equal(ema([1, 2, 3, 4, 5], 3), 4);
});

test("ema: null when fewer points than the period", () => {
  assert.equal(ema([1, 2], 3), null);
});

test("macd: null when there isn't enough history for slow EMA + signal EMA", () => {
  assert.equal(macd([1, 2, 3], 12, 26, 9), null);
});

test("macd: on a straight-line-up series, fast EMA stays above slow EMA (positive macd) and histogram sign is stable", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i); // strictly increasing
  const r = macd(closes)!;
  assert.ok(r !== null);
  assert.ok(r.macd > 0, "fast EMA(12) must be above slow EMA(26) on a steady uptrend");
  assert.equal(r.histogram, r.macd - r.signal);
});

test("rsi: a strictly increasing series has no losses -> RSI = 100", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(rsi(closes, 14), 100);
});

test("rsi: a strictly decreasing series has no gains -> RSI = 0", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(rsi(closes, 14), 0);
});

test("rsi: null when fewer than period+1 points", () => {
  assert.equal(rsi([1, 2, 3], 14), null);
});

test("bollinger: flat series collapses all 3 bands onto the same value (zero stddev)", () => {
  const closes = Array(20).fill(100);
  const b = bollinger(closes, 20, 2)!;
  assert.equal(b.upper, 100);
  assert.equal(b.middle, 100);
  assert.equal(b.lower, 100);
});

test("bollinger: upper/lower are symmetric around the middle", () => {
  const closes = [10, 12, 9, 15, 11, 13, 8, 14, 10, 12, 11, 13, 9, 15, 10, 12, 11, 14, 9, 13];
  const b = bollinger(closes, 20, 2)!;
  assert.ok(Math.abs((b.upper - b.middle) - (b.middle - b.lower)) < 1e-9);
});

test("kd: a monotonically rising price series pushes K and D toward 100 (RSV pinned near 100 every day)", () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ high: 100 + i + 0.5, low: 100 + i - 0.5, close: 100 + i }));
  const r = kd(points, 9)!;
  assert.ok(r.k > 90, `expected K near 100 on a steady uptrend, got ${r.k}`);
  assert.ok(r.d > 80, `expected D trailing K upward, got ${r.d}`);
});

test("kd: null when fewer points than rsvPeriod", () => {
  assert.equal(kd([{ high: 1, low: 1, close: 1 }], 9), null);
});

test("nDayHighLow: today's close above the whole prior window is flagged as a new N-day high", () => {
  const closes = [10, 11, 9, 12, 8, 15]; // last value 15 is the highest of all 6
  const r = nDayHighLow(closes, 6)!;
  assert.equal(r.high, 15);
  assert.equal(r.isNewHigh, true);
  assert.equal(r.isNewLow, false);
});

test("nDayHighLow: null when fewer points than the period", () => {
  assert.equal(nDayHighLow([1, 2], 5), null);
});

test("volumeMultiple: today's volume vs the average of the PRIOR period days (today excluded from the average)", () => {
  const volumes = [...Array(20).fill(100), 400]; // 20 days at 100, then today at 400
  assert.equal(volumeMultiple(volumes, 20), 4);
});

test("volumeMultiple: null if any prior-window volume is missing", () => {
  const volumes = [...Array(19).fill(100), null, 400];
  assert.equal(volumeMultiple(volumes, 20), null);
});

test("volumeMultiple: null when fewer than period+1 points", () => {
  assert.equal(volumeMultiple([100, 200], 20), null);
});
