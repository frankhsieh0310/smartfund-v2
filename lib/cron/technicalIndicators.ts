// Task X9 (round-5 commodity instruction, section 2-3/3-1): standard-formula technical indicators,
// computed ONLY from closing price (and volume, for the volume-multiple check) -- this is the one
// explicitly-permitted exception to this codebase's "照抄不計算 / copy, never derive" rule, since an
// indicator is inherently a derived figure. No equivalent writer exists anywhere in this repo's git
// history for either `stock_technical` or `futures_technical_analytics` (confirmed via `git log --all
// -S` pickaxe search on several distinctive field names -- whatever populated those tables historically
// was never committed here), so this is a fresh implementation, not a port. Every function takes a
// plain ascending-by-date array of closes (and volumes where needed) and is pure / unit-testable
// without a database.

export type OhlcvPoint = { date: string; open: number; high: number; low: number; close: number; volume: number | null };

/** Simple moving average of the last `period` closes. null if fewer than `period` points exist. */
export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  return window.reduce((a, b) => a + b, 0) / period;
}

/** Exponential moving average over the WHOLE series (seeded with a leading SMA(period), standard
 * practice), returned as the single latest value. null if fewer than `period` points exist. */
export function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let value = closes.slice(0, period).reduce((a, b) => a + b, 0) / period; // seed = SMA(period)
  for (let i = period; i < closes.length; i++) value = closes[i] * k + value * (1 - k);
  return value;
}

/** Full EMA series (not just the latest value) -- needed internally for MACD's signal line, which is
 * itself an EMA of the MACD line, not of price. */
function emaSeries(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let value = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(value);
  for (let i = period; i < closes.length; i++) { value = closes[i] * k + value * (1 - k); out.push(value); }
  return out;
}

export type Macd = { macd: number; signal: number; histogram: number };

/** Standard MACD(12,26,9): macd = EMA12 - EMA26 (aligned on the EMA26 series, since EMA26 is always
 * shorter/later-starting than EMA12), signal = EMA9 of the macd line, histogram = macd - signal. */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): Macd | null {
  if (closes.length < slow + signalPeriod) return null;
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  // fastSeries is longer (starts earlier) than slowSeries by (slow - fast) points; align on slowSeries.
  const offset = fastSeries.length - slowSeries.length;
  const macdSeries = slowSeries.map((slowVal, i) => fastSeries[i + offset] - slowVal);
  const signalSeries = emaSeries(macdSeries, signalPeriod);
  if (signalSeries.length === 0) return null;
  const latestMacd = macdSeries[macdSeries.length - 1];
  const latestSignal = signalSeries[signalSeries.length - 1];
  return { macd: latestMacd, signal: latestSignal, histogram: latestMacd - latestSignal };
}

/** Standard Wilder's RSI(14): average gain/loss over the period, smoothed Wilder-style (not a plain
 * SMA re-computed each step) for every point after the first `period` average. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) { const c = changes[i]; if (c > 0) avgGain += c; else avgLoss += -c; }
  avgGain /= period; avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    const gain = c > 0 ? c : 0, loss = c < 0 ? -c : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export type Bollinger = { upper: number; middle: number; lower: number };

/** Standard Bollinger Bands: middle = SMA(period), bands = middle +/- numStdDev * population stddev
 * of the same window (population, not sample, per the original Bollinger convention). */
export function bollinger(closes: number[], period = 20, numStdDev = 2): Bollinger | null {
  const middle = sma(closes, period);
  if (middle === null) return null;
  const window = closes.slice(closes.length - period);
  const variance = window.reduce((acc, v) => acc + (v - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: middle + numStdDev * stdDev, middle, lower: middle - numStdDev * stdDev };
}

export type Kd = { k: number; d: number };

/** Standard slow-stochastic KD (the same formula/parameters used for Taiwan equities: RSV period 9,
 * K/D smoothing factor 1/3, both seeded at 50) computed over the whole series so the smoothing
 * recursion is correct, returning only the latest K/D. rsvPeriod needs `high`/`low` series, not just
 * close -- callers must pass full OHLC. */
export function kd(points: Array<{ high: number; low: number; close: number }>, rsvPeriod = 9): Kd | null {
  if (points.length < rsvPeriod) return null;
  let k = 50, d = 50;
  for (let i = rsvPeriod - 1; i < points.length; i++) {
    const window = points.slice(i - rsvPeriod + 1, i + 1);
    const highN = Math.max(...window.map((p) => p.high));
    const lowN = Math.min(...window.map((p) => p.low));
    const rsv = highN === lowN ? 50 : ((points[i].close - lowN) / (highN - lowN)) * 100;
    k = (k * 2 + rsv) / 3;
    d = (d * 2 + k) / 3;
  }
  return { k, d };
}

/** N-day high/low over the trailing `period` closes (inclusive of today) -- "N日新高/新低" as asked
 * for: whether today's close IS the N-day high/low, plus the N-day high/low values themselves for
 * display. null if fewer than `period` points exist. */
export function nDayHighLow(closes: number[], period: number): { high: number; low: number; isNewHigh: boolean; isNewLow: boolean } | null {
  if (closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  const high = Math.max(...window);
  const low = Math.min(...window);
  const today = closes[closes.length - 1];
  return { high, low, isNewHigh: today >= high, isNewLow: today <= low };
}

/** Volume as a multiple of its own trailing N-day average (today's volume included in neither the
 * "today" numerator ambiguity nor excluded from the denominator -- the average is of the PRIOR
 * `period` days, today's volume is compared against that baseline, matching "今天的量是過去N天均量的
 * 幾倍" the way a trader would read it). null if fewer than `period+1` points exist or average is 0. */
export function volumeMultiple(volumes: Array<number | null>, period = 20): number | null {
  if (volumes.length < period + 1) return null;
  const today = volumes[volumes.length - 1];
  if (today === null) return null;
  const priorWindow = volumes.slice(volumes.length - 1 - period, volumes.length - 1);
  if (priorWindow.some((v) => v === null)) return null;
  const avg = (priorWindow as number[]).reduce((a, b) => a + b, 0) / period;
  if (avg === 0) return null;
  return today / avg;
}
