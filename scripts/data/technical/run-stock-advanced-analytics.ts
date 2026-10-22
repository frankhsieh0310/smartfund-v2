import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type Bar = {
  date: Date;
  open: any;
  high: any;
  low: any;
  close: any;
  volume: any;
};
type NBar = {
  date: Date;
  open: number;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
};
const market = process.argv
  .find((x) => x.startsWith("--market="))
  ?.slice(9)
  .toUpperCase();
if (!market) throw new Error("MARKET_REQUIRED");
const symbol =
  process.argv
    .find((x) => x.startsWith("--symbol="))
    ?.slice(9)
    .toUpperCase() ?? null;
const limit = Math.min(
  200,
  Math.max(
    50,
    Number(process.argv.find((x) => x.startsWith("--limit="))?.slice(8) ?? 50),
  ),
);
const rt = resolve("runtime", "stock-advanced-analytics"),
  cpFile = resolve(rt, `${market.toLowerCase()}.json`);
function dbUrl() {
  const s = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!s) return undefined;
  const u = new URL(s.replace(":5432/", ":6543/"));
  u.searchParams.set("pgbouncer", "true");
  u.searchParams.set("connection_limit", "1");
  return u.toString();
}
const db = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
const now = () => new Date().toISOString();
async function read<T>(f: string, d: T) {
  try {
    return JSON.parse(await readFile(f, "utf8")) as T;
  } catch {
    return d;
  }
}
async function atomic(f: string, v: unknown) {
  await mkdir(rt, { recursive: true });
  const t = `${f}.${process.pid}.tmp`;
  await writeFile(t, `${JSON.stringify(v, null, 2)}\n`);
  await rename(t, f);
}
const num = (v: any) =>
    v === null || v === undefined
      ? null
      : typeof v === "number"
        ? v
        : v.toNumber(),
  finite = (v: number | null) =>
    v !== null && Number.isFinite(v) ? Number(v.toFixed(12)) : null;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length,
  std = (a: number[]) => {
    const m = mean(a);
    return Math.sqrt(
      a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1),
    );
  },
  median = (a: number[]) => {
    const x = [...a].sort((p, q) => p - q),
      m = Math.floor(x.length / 2);
    return x.length % 2 ? x[m]! : (x[m - 1]! + x[m]!) / 2;
  };
function ema(a: number[], p: number) {
  if (a.length < p) return null;
  let e = mean(a.slice(0, p)),
    k = 2 / (p + 1);
  for (const x of a.slice(p)) e = (x - e) * k + e;
  return e;
}
function rsi(a: number[], p = 14) {
  if (a.length <= p) return null;
  let g = 0,
    l = 0;
  for (let i = a.length - p; i < a.length; i++) {
    const d = a[i]! - a[i - 1]!;
    g += Math.max(0, d);
    l += Math.max(0, -d);
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function adx(b: NBar[], p = 14) {
  const v = b.filter((x) => x.high !== null && x.low !== null);
  if (v.length < p * 2 + 1) return null;
  const dx: number[] = [];
  for (let end = p; end < v.length; end++) {
    let tr = 0,
      plus = 0,
      minus = 0;
    for (let i = end - p + 1; i <= end; i++) {
      const c = v[i]!,
        q = v[i - 1]!,
        up = c.high! - q.high!,
        dn = q.low! - c.low!;
      tr += Math.max(
        c.high! - c.low!,
        Math.abs(c.high! - q.close),
        Math.abs(c.low! - q.close),
      );
      if (up > dn && up > 0) plus += up;
      if (dn > up && dn > 0) minus += dn;
    }
    if (tr === 0) continue;
    const pi = (100 * plus) / tr,
      mi = (100 * minus) / tr,
      sum = pi + mi;
    dx.push(sum ? (100 * Math.abs(pi - mi)) / sum : 0);
  }
  if (dx.length < p) return null;
  let tr = 0,
    plus = 0,
    minus = 0;
  for (let i = v.length - p; i < v.length; i++) {
    const c = v[i]!,
      q = v[i - 1]!,
      up = c.high! - q.high!,
      dn = q.low! - c.low!;
    tr += Math.max(
      c.high! - c.low!,
      Math.abs(c.high! - q.close),
      Math.abs(c.low! - q.close),
    );
    if (up > dn && up > 0) plus += up;
    if (dn > up && dn > 0) minus += dn;
  }
  return {
    adx: mean(dx.slice(-p)),
    plus: tr ? (100 * plus) / tr : 0,
    minus: tr ? (100 * minus) / tr : 0,
  };
}
function group(b: NBar[], tf: "WEEKLY" | "MONTHLY") {
  const m = new Map<string, NBar[]>();
  for (const x of b) {
    const d = x.date,
      key =
        tf === "MONTHLY"
          ? d.toISOString().slice(0, 7)
          : (() => {
              const q = new Date(d),
                day = q.getUTCDay() || 7;
              q.setUTCDate(q.getUTCDate() - day + 1);
              return q.toISOString().slice(0, 10);
            })();
    m.set(key, [...(m.get(key) ?? []), x]);
  }
  const groups = [...m.values()];
  groups.pop();
  return groups.map((x) => ({
    date: x.at(-1)!.date,
    open: x[0]!.open,
    high: x.every((y) => y.high !== null)
      ? Math.max(...x.map((y) => y.high!))
      : null,
    low: x.every((y) => y.low !== null)
      ? Math.min(...x.map((y) => y.low!))
      : null,
    close: x.at(-1)!.close,
    volume: x.every((y) => y.volume !== null)
      ? x.reduce((s, y) => s + y.volume!, 0)
      : null,
  }));
}
type Metric = {
  tf: "DAILY" | "WEEKLY" | "MONTHLY";
  key: string;
  kind: "NUMERIC_METRIC" | "STATE_METRIC";
  window: number;
  value?: number;
  state?: string;
  meta?: any;
};
function core(b: NBar[], tf: Metric["tf"]) {
  const c = b.map((x) => x.close),
    out: Metric[] = [];
  const add = (key: string, w: number, v: number | null) => {
    if (v !== null && Number.isFinite(v))
      out.push({ tf, key, kind: "NUMERIC_METRIC", window: w, value: v });
  };
  for (const w of tf === "DAILY" ? [5, 10, 20, 60, 120, 252] : [5, 12, 20])
    if (c.length > w) add("ROC", w, c.at(-1)! / c.at(-w - 1)! - 1);
  for (const w of tf === "DAILY" ? [20, 60, 120, 252] : [12, 20])
    if (c.length > w) {
      const r = c
        .slice(-w - 1)
        .slice(1)
        .map((x, i) => Math.log(x / c.slice(-w - 1)[i]!));
      add(
        "REALIZED_VOLATILITY",
        w,
        std(r) * Math.sqrt(tf === "DAILY" ? 252 : tf === "WEEKLY" ? 52 : 12),
      );
    }
  if (c.length >= 20) {
    add("SMA", 20, mean(c.slice(-20)));
    add("EMA", 20, ema(c, 20));
    add("RSI", 14, rsi(c));
    const e12 = ema(c, 12),
      e26 = ema(c, 26);
    if (e12 !== null && e26 !== null) {
      const macd = e12 - e26;
      add("MACD", 0, macd);
    }
  }
  add("DRAWDOWN", 0, c.at(-1)! / Math.max(...c) - 1);
  const a = adx(b);
  if (a) {
    add("ADX", 14, a.adx);
    add("PLUS_DI", 14, a.plus);
    add("MINUS_DI", 14, a.minus);
  }
  return out;
}
function dailyExtra(b: NBar[]) {
  const c = b.map((x) => x.close),
    out: Metric[] = [];
  for (const w of [20, 60, 120, 252])
    if (c.length > w)
      out.push({
        tf: "DAILY",
        key: "MOMENTUM",
        kind: "NUMERIC_METRIC",
        window: w,
        value: c.at(-1)! - c.at(-w - 1)!,
      });
  if (c.length >= 252) {
    const h = Math.max(...c.slice(-252)),
      l = Math.min(...c.slice(-252)),
      last = c.at(-1)!;
    out.push(
      {
        tf: "DAILY",
        key: "DISTANCE_FROM_52W_HIGH",
        kind: "NUMERIC_METRIC",
        window: 252,
        value: last / h - 1,
      },
      {
        tf: "DAILY",
        key: "DISTANCE_FROM_52W_LOW",
        kind: "NUMERIC_METRIC",
        window: 252,
        value: last / l - 1,
      },
    );
  }
  for (const w of [20, 55])
    if (c.length > w) {
      const prior = c.slice(-w - 1, -1),
        last = c.at(-1)!,
        state =
          last > Math.max(...prior)
            ? "HIGH_BREAKOUT"
            : last < Math.min(...prior)
              ? "LOW_BREAKDOWN"
              : "NEUTRAL";
      out.push({
        tf: "DAILY",
        key: "BREAKOUT_STATE",
        kind: "STATE_METRIC",
        window: w,
        state,
      });
    }
  const roc20 = c.length > 20 ? c.at(-1)! / c.at(-21)! - 1 : 0,
    roc60 = c.length > 60 ? c.at(-1)! / c.at(-61)! - 1 : 0,
    s20 = c.length >= 20 ? mean(c.slice(-20)) : c.at(-1)!,
    s60 = c.length >= 60 ? mean(c.slice(-60)) : s20;
  const trend =
    c.at(-1)! > s20 && s20 > s60 && roc60 > 0.1
      ? "STRONG_UPTREND"
      : c.at(-1)! > s60 && roc60 > 0
        ? "UPTREND"
        : c.at(-1)! < s20 && s20 < s60 && roc60 < -0.1
          ? "STRONG_DOWNTREND"
          : c.at(-1)! < s60 && roc60 < 0
            ? "DOWNTREND"
            : "NEUTRAL";
  const momentum =
    roc20 > 0.1
      ? "STRONG_POSITIVE"
      : roc20 > 0.03
        ? "POSITIVE"
        : roc20 < -0.1
          ? "STRONG_NEGATIVE"
          : roc20 < -0.03
            ? "NEGATIVE"
            : "NEUTRAL";
  out.push(
    {
      tf: "DAILY",
      key: "TREND_STATE",
      kind: "STATE_METRIC",
      window: 0,
      state: trend,
    },
    {
      tf: "DAILY",
      key: "MOMENTUM_STATE",
      kind: "STATE_METRIC",
      window: 20,
      state: momentum,
    },
  );
  if (c.length >= 272) {
    const r = c.slice(1).map((x, i) => Math.log(x / c[i]!)),
      rv = [];
    for (let i = 19; i < r.length; i++)
      rv.push(std(r.slice(i - 19, i + 1)) * Math.sqrt(252));
    const current = rv.at(-1)!,
      rank = rv.filter((x) => x <= current).length / rv.length,
      state =
        rank < 0.2
          ? "VERY_LOW"
          : rank < 0.4
            ? "LOW"
            : rank < 0.6
              ? "NORMAL"
              : rank < 0.8
                ? "HIGH"
                : "VERY_HIGH";
    out.push({
      tf: "DAILY",
      key: "VOLATILITY_STATE",
      kind: "STATE_METRIC",
      window: 20,
      state,
      meta: { historicalPercentile: rank },
    });
  }
  if (b.every((x) => x.volume !== null) && b.length >= 61) {
    const vols = b.map((x) => x.volume!),
      last = vols.at(-1)!,
      a20 = mean(vols.slice(-20)),
      a60 = mean(vols.slice(-60)),
      z = std(vols.slice(-20));
    out.push(
      {
        tf: "DAILY",
        key: "RELATIVE_VOLUME",
        kind: "NUMERIC_METRIC",
        window: 20,
        value: a20 ? last / a20 : 0,
      },
      {
        tf: "DAILY",
        key: "RELATIVE_VOLUME",
        kind: "NUMERIC_METRIC",
        window: 60,
        value: a60 ? last / a60 : 0,
      },
      {
        tf: "DAILY",
        key: "VOLUME_ZSCORE",
        kind: "NUMERIC_METRIC",
        window: 20,
        value: z ? (last - a20) / z : 0,
      },
      {
        tf: "DAILY",
        key: "PRICE_VOLUME_STATE",
        kind: "STATE_METRIC",
        window: 20,
        state:
          c.at(-1)! >= c.at(-2)!
            ? last >= a20
              ? "PRICE_UP_VOLUME_UP"
              : "PRICE_UP_VOLUME_DOWN"
            : last >= a20
              ? "PRICE_DOWN_VOLUME_UP"
              : "PRICE_DOWN_VOLUME_DOWN",
      },
    );
  }
  return out;
}
function ohlcvExtra(b: NBar[]): Metric[] {
  const out: Metric[] = [],
    close = b.map((x) => x.close),
    high = b.map((x) => x.high),
    low = b.map((x) => x.low),
    volume = b.map((x) => x.volume);
  if (
    b.length < 30 ||
    high.some((x) => x === null) ||
    low.some((x) => x === null)
  )
    return out;
  const h = high as number[],
    l = low as number[],
    last = close.at(-1)!;
  const add = (key: string, window: number, value: number | null) => {
    if (value !== null && Number.isFinite(value))
      out.push({ tf: "DAILY", key, kind: "NUMERIC_METRIC", window, value });
  };
  const state = (key: string, value: string) =>
    out.push({
      tf: "DAILY",
      key,
      kind: "STATE_METRIC",
      window: 0,
      state: value,
    });
  const weighted = (values: number[]) =>
    values.reduce((sum, value, index) => sum + value * (index + 1), 0) /
    ((values.length * (values.length + 1)) / 2);
  const trueRanges = b
    .slice(1)
    .map((x, index) =>
      Math.max(
        h[index + 1]! - l[index + 1]!,
        Math.abs(h[index + 1]! - close[index]!),
        Math.abs(l[index + 1]! - close[index]!),
      ),
    );
  const atr14 = mean(trueRanges.slice(-14)),
    sma20 = mean(close.slice(-20)),
    deviation20 = std(close.slice(-20)),
    ema20 = ema(close, 20);
  add("SMA", 10, mean(close.slice(-10)));
  add("WMA", 20, weighted(close.slice(-20)));
  add("EMA", 50, ema(close, 50));
  add("EMA", 200, ema(close, 200));
  add("ATR", 14, atr14);
  add("BOLLINGER_UPPER", 20, sma20 + 2 * deviation20);
  add("BOLLINGER_MIDDLE", 20, sma20);
  add("BOLLINGER_LOWER", 20, sma20 - 2 * deviation20);
  if (ema20 !== null) {
    add("KELTNER_UPPER", 20, ema20 + 2 * atr14);
    add("KELTNER_MIDDLE", 20, ema20);
    add("KELTNER_LOWER", 20, ema20 - 2 * atr14);
    add(
      "SUPERTREND",
      14,
      last >= ema20 ? ema20 - 3 * atr14 : ema20 + 3 * atr14,
    );
  }
  const hh14 = Math.max(...h.slice(-14)),
    ll14 = Math.min(...l.slice(-14)),
    stochastic = ((last - ll14) / (hh14 - ll14 || 1)) * 100;
  add("STOCHASTIC_K", 14, stochastic);
  add(
    "STOCHASTIC_D",
    3,
    mean(
      close
        .slice(-3)
        .map((value) => ((value - ll14) / (hh14 - ll14 || 1)) * 100),
    ),
  );
  add("WILLIAMS_R", 14, (-100 * (hh14 - last)) / (hh14 - ll14 || 1));
  const typical = b.map((x, index) => (h[index]! + l[index]! + x.close) / 3),
    typical20 = typical.slice(-20),
    typicalMean = mean(typical20),
    meanDeviation = mean(
      typical20.map((value) => Math.abs(value - typicalMean)),
    );
  add(
    "CCI",
    20,
    meanDeviation
      ? (typical.at(-1)! - typicalMean) / (0.015 * meanDeviation)
      : null,
  );
  add("DONCHIAN_UPPER", 20, Math.max(...h.slice(-20)));
  add("DONCHIAN_LOWER", 20, Math.min(...l.slice(-20)));
  if (volume.every((value) => value !== null)) {
    const volumes = volume as number[];
    add("VOLUME_SMA", 20, mean(volumes.slice(-20)));
    let obv = 0,
      accumulation = 0;
    for (let index = 1; index < b.length; index += 1) {
      obv +=
        close[index]! > close[index - 1]!
          ? volumes[index]!
          : close[index]! < close[index - 1]!
            ? -volumes[index]!
            : 0;
      accumulation +=
        ((2 * close[index]! - l[index]! - h[index]!) /
          (h[index]! - l[index] || 1)) *
        volumes[index]!;
    }
    add("OBV", 0, obv);
    add("ACCUMULATION_DISTRIBUTION", 0, accumulation);
    const money = b
        .slice(-20)
        .map(
          (_, index) =>
            typical[b.length - 20 + index]! * volumes[b.length - 20 + index]!,
        ),
      positive = money
        .filter(
          (_, index) =>
            index === 0 ||
            typical[b.length - 20 + index]! >= typical[b.length - 21 + index]!,
        )
        .reduce((a, x) => a + x, 0),
      negative = money
        .filter(
          (_, index) =>
            index > 0 &&
            typical[b.length - 20 + index]! < typical[b.length - 21 + index]!,
        )
        .reduce((a, x) => a + x, 0);
    add("MFI", 14, negative ? 100 - 100 / (1 + positive / negative) : 100);
    add(
      "CMF",
      20,
      b
        .slice(-20)
        .reduce(
          (sum, x, index) =>
            sum +
            ((2 * x.close - x.low! - x.high!) / (x.high! - x.low! || 1)) *
              volumes[b.length - 20 + index]!,
          0,
        ) / (volumes.slice(-20).reduce((a, x) => a + x, 0) || 1),
    );
    const vwap = (start: number) => {
      let numerator = 0,
        denominator = 0;
      for (let index = start; index < b.length; index += 1) {
        numerator += typical[index]! * volumes[index]!;
        denominator += volumes[index]!;
      }
      return denominator ? numerator / denominator : null;
    };
    add("ROLLING_VWAP", 20, vwap(Math.max(0, b.length - 20)));
    add("ANCHORED_VWAP", b.length, vwap(0));
  }
  const priorHigh = Math.max(...h.slice(-21, -1)),
    priorLow = Math.min(...l.slice(-21, -1)),
    pivot = (h.at(-2)! + l.at(-2)! + close.at(-2)!) / 3;
  add("PREVIOUS_HIGH", 20, priorHigh);
  add("PREVIOUS_LOW", 20, priorLow);
  add("PIVOT", 1, pivot);
  for (const [key, ratio] of [
    ["FIBONACCI_382", 0.382],
    ["FIBONACCI_500", 0.5],
    ["FIBONACCI_618", 0.618],
  ] as const)
    add(key, 20, priorHigh - (priorHigh - priorLow) * ratio);
  state(
    "MARKET_STRUCTURE",
    h.at(-1)! > h.at(-2)! && l.at(-1)! > l.at(-2)!
      ? "HH_HL"
      : h.at(-1)! < h.at(-2)! && l.at(-1)! < l.at(-2)!
        ? "LH_LL"
        : "MIXED",
  );
  state(
    "BREAKOUT_STATE",
    last > priorHigh
      ? "HIGH_BREAKOUT"
      : last < priorLow
        ? "LOW_BREAKDOWN"
        : "NEUTRAL",
  );
  const current = b.at(-1)!,
    range = h.at(-1)! - l.at(-1)!,
    body = Math.abs(last - current.open),
    upper = h.at(-1)! - Math.max(current.open, last),
    lower = Math.min(current.open, last) - l.at(-1)!,
    patterns: string[] = [];
  if (body <= range * 0.1) patterns.push("DOJI");
  if (lower >= body * 2 && upper <= body) patterns.push("HAMMER");
  if (upper >= body * 2 && lower <= body)
    patterns.push(last < current.open ? "SHOOTING_STAR" : "INVERTED_HAMMER");
  const previous = b.at(-2)!;
  if (
    current.open < previous.close &&
    last > previous.open &&
    last > current.open
  )
    patterns.push("BULLISH_ENGULFING");
  if (
    current.open > previous.close &&
    last < previous.open &&
    last < current.open
  )
    patterns.push("BEARISH_ENGULFING");
  state("CANDLE_PATTERNS", patterns.length ? patterns.join("|") : "NONE");
  add(
    "ICHIMOKU_TENKAN",
    9,
    (Math.max(...h.slice(-9)) + Math.min(...l.slice(-9))) / 2,
  );
  add(
    "ICHIMOKU_KIJUN",
    26,
    (Math.max(...h.slice(-26)) + Math.min(...l.slice(-26))) / 2,
  );
  const ema50 = ema(close, 50),
    ema200 = ema(close, 200),
    trendScore =
      (last > sma20 ? 1 : -1) +
      (ema50 !== null && last > ema50 ? 1 : -1) +
      (ema200 !== null && last > ema200 ? 1 : -1),
    currentRsi = rsi(close) ?? 50,
    momentumScore =
      (currentRsi > 55 ? 1 : currentRsi < 45 ? -1 : 0) +
      (last > close.at(-13)! ? 1 : -1),
    volumeScore =
      volume.every((value) => value !== null) &&
      volume.at(-1)! > mean((volume as number[]).slice(-20))
        ? 1
        : 0,
    volatilityScore = atr14 / last < 0.03 ? 1 : -1;
  add("TREND_SCORE", 0, trendScore);
  add("MOMENTUM_SCORE", 0, momentumScore);
  add("VOLUME_SCORE", 0, volumeScore);
  add("VOLATILITY_SCORE", 0, volatilityScore);
  add(
    "COMPOSITE_SCORE",
    0,
    trendScore + momentumScore + volumeScore + volatilityScore,
  );
  const signals: number[] = [];
  for (let index = 20; index < close.length - 60; index += 1)
    if (close[index]! > Math.max(...h.slice(index - 20, index)))
      signals.push(index);
  if (signals.length) {
    add("VALIDATION_SIGNAL_COUNT", 0, signals.length);
    for (const days of [5, 20, 60]) {
      const returns = signals.map(
        (index) => close[index + days]! / close[index]! - 1,
      );
      add(
        "VALIDATION_HIT_RATE",
        days,
        returns.filter((value) => value > 0).length / returns.length,
      );
      add("VALIDATION_AVERAGE_RETURN", days, mean(returns));
    }
    const favorable = signals.map(
        (index) =>
          Math.max(...h.slice(index + 1, index + 61)) / close[index]! - 1,
      ),
      adverse = signals.map(
        (index) =>
          Math.min(...l.slice(index + 1, index + 61)) / close[index]! - 1,
      );
    add("VALIDATION_MAX_FAVORABLE", 60, Math.max(...favorable));
    add("VALIDATION_MAX_ADVERSE", 60, Math.min(...adverse));
  }
  return out;
}
function seasons(b: NBar[]) {
  const ret = b
      .slice(1)
      .map((x, i) => ({ d: x.date, v: x.close / b[i]!.close - 1 })),
    summ = (a: number[]) => ({
      n: a.length,
      mean: mean(a),
      med: median(a),
      hit: a.filter((x) => x > 0).length / a.length,
      sd: std(a),
      min: Math.min(...a),
      max: Math.max(...a),
    }),
    out: any[] = [];
  const monthNames = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  for (let i = 0; i < 12; i++) {
    const a = ret.filter((x) => x.d.getUTCMonth() === i).map((x) => x.v);
    if (a.length >= 8)
      out.push({ type: "MONTH_OF_YEAR", bucket: monthNames[i], ...summ(a) });
  }
  for (let i = 1; i <= 5; i++) {
    const a = ret.filter((x) => x.d.getUTCDay() === i).map((x) => x.v);
    if (a.length >= 20)
      out.push({
        type: "DAY_OF_WEEK",
        bucket: ["", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"][i],
        ...summ(a),
      });
  }
  for (let q = 0; q < 4; q++) {
    const a = ret
      .filter((x) => Math.floor(x.d.getUTCMonth() / 3) === q)
      .map((x) => x.v);
    if (a.length >= 20)
      out.push({ type: "QUARTER", bucket: `Q${q + 1}`, ...summ(a) });
  }
  const byMonth = new Map<string, typeof ret>();
  for (const x of ret) {
    const k = x.d.toISOString().slice(0, 7);
    byMonth.set(k, [...(byMonth.get(k) ?? []), x]);
  }
  const turn = [...byMonth.values()]
    .flatMap((a) => [...a.slice(0, 3), ...a.slice(-3)])
    .map((x) => x.v);
  if (turn.length >= 24)
    out.push({ type: "TURN_OF_MONTH", bucket: "LAST3_FIRST3", ...summ(turn) });
  return out;
}
async function processStock(s: any) {
  const raw = await db.$queryRawUnsafe<Bar[]>(
    `SELECT date,open,high,low,close,volume FROM(SELECT date,open,high,low,close,volume FROM stock_history WHERE stock_id=$1 ORDER BY date DESC LIMIT 2000)x ORDER BY date`,
    s.id,
  );
  const b = raw.map((x) => ({
    date: x.date,
    open: num(x.open) ?? num(x.close)!,
    high: num(x.high),
    low: num(x.low),
    close: num(x.close)!,
    volume: num(x.volume),
  }));
  if (b.length < 20) return { status: "INPUT_INSUFFICIENT", rows: 0 };
  const asOf = b.at(-1)!.date.toISOString().slice(0, 10),
    fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          b.map((x) => [
            x.date.toISOString().slice(0, 10),
            x.open,
            x.high,
            x.low,
            x.close,
            x.volume,
          ]),
        ),
      )
      .digest("hex"),
    source = `STOCK_HISTORY_SHA256:${fingerprint}`;
  const old = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT EXISTS(SELECT 1 FROM stock_analytics WHERE stock_id=$1 AND source_input_version=$2 AND calculation_version='TECHNICAL_V3') ok`,
    s.id,
    source,
  );
  if (old[0]?.ok) return { status: "UP_TO_DATE", rows: 0 };
  const w = group(b, "WEEKLY"),
    m = group(b, "MONTHLY"),
    metrics = [
      ...core(b, "DAILY"),
      ...dailyExtra(b),
      ...ohlcvExtra(b),
      ...core(w, "WEEKLY"),
      ...core(m, "MONTHLY"),
    ],
    trend = (tf: string) =>
      metrics.find((x) => x.tf === tf && x.key === "TREND_STATE")?.state;
  for (const [bars, tf] of [
    [w, "WEEKLY"],
    [m, "MONTHLY"],
  ] as const) {
    const c = bars.map((x) => x.close);
    if (c.length >= 60) {
      const r60 = c.at(-1)! / c.at(-61)! - 1,
        s20 = mean(c.slice(-20)),
        s60 = mean(c.slice(-60)),
        last = c.at(-1)!,
        state =
          last > s20 && s20 > s60 && r60 > 0.1
            ? "STRONG_UPTREND"
            : last > s60 && r60 > 0
              ? "UPTREND"
              : last < s20 && s20 < s60 && r60 < -0.1
                ? "STRONG_DOWNTREND"
                : last < s60 && r60 < 0
                  ? "DOWNTREND"
                  : "NEUTRAL";
      metrics.push({
        tf,
        key: "TREND_STATE",
        kind: "STATE_METRIC",
        window: 0,
        state,
      });
    }
  }
  const states = ["DAILY", "WEEKLY", "MONTHLY"].map(trend),
    score = states.reduce(
      (n, x) =>
        n + (x?.includes("UPTREND") ? 1 : x?.includes("DOWNTREND") ? -1 : 0),
      0,
    ),
    align = states.some((x) => !x)
      ? "INPUT_INSUFFICIENT"
      : score === 3
        ? "BULLISH_ALIGNED"
        : score >= 1
          ? "MOSTLY_BULLISH"
          : score === -3
            ? "BEARISH_ALIGNED"
            : score <= -1
              ? "MOSTLY_BEARISH"
              : "MIXED";
  metrics.push({
    tf: "DAILY",
    key: "TIMEFRAME_ALIGNMENT",
    kind: "STATE_METRIC",
    window: 0,
    state: align,
    meta: { componentStates: states },
  });
  const sea = b.length >= 504 ? seasons(b) : [];
  const known = now();
  await db.$transaction(
    async (tx) => {
      for (const x of metrics) {
        const value =
          x.kind === "NUMERIC_METRIC" ? finite(x.value ?? null) : null;
        if (x.kind === "NUMERIC_METRIC" && value === null) continue;
        await tx.$executeRawUnsafe(
          `INSERT INTO stock_analytics(id,stock_id,as_of,timeframe,metric_key,metric_kind,"window",calculation_version,value,state_value,source_input_version,known_at,metadata) VALUES($1::uuid,$2,$3::date,$4::"StockAnalyticsTimeframe",$5,$6::"StockAnalyticsMetricKind",$7,'TECHNICAL_V3',$8,$9,$10,$11::timestamptz,$12::jsonb) ON CONFLICT(stock_id,as_of,timeframe,metric_key,"window",calculation_version) DO UPDATE SET value=EXCLUDED.value,state_value=EXCLUDED.state_value,source_input_version=EXCLUDED.source_input_version,known_at=EXCLUDED.known_at,computed_at=NOW(),metadata=EXCLUDED.metadata`,
          randomUUID(),
          s.id,
          asOf,
          x.tf,
          x.key,
          x.kind,
          x.window,
          value,
          x.state ?? null,
          source,
          known,
          JSON.stringify({
            source: "SMARTFUND_DERIVED",
            inputDomain: "STOCK_PRICE_HISTORY",
            inputMaxDate: asOf,
            ...x.meta,
          }),
        );
      }
      for (const x of sea)
        await tx.$executeRawUnsafe(
          `INSERT INTO stock_seasonality(id,stock_id,as_of,seasonality_type,bucket,lookback_window,sample_count,calculation_version,mean_return,median_return,hit_rate,std_dev,min_return,max_return,source_input_version,known_at,metadata) VALUES($1::uuid,$2,$3::date,$4::"StockSeasonalityType",$5,$6,$7,'SEASONALITY_V1',$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::jsonb) ON CONFLICT(stock_id,as_of,seasonality_type,bucket,lookback_window,calculation_version) DO UPDATE SET sample_count=EXCLUDED.sample_count,mean_return=EXCLUDED.mean_return,median_return=EXCLUDED.median_return,hit_rate=EXCLUDED.hit_rate,std_dev=EXCLUDED.std_dev,min_return=EXCLUDED.min_return,max_return=EXCLUDED.max_return,source_input_version=EXCLUDED.source_input_version,known_at=EXCLUDED.known_at,computed_at=NOW(),metadata=EXCLUDED.metadata`,
          randomUUID(),
          s.id,
          asOf,
          x.type,
          x.bucket,
          b.length,
          x.n,
          x.mean,
          x.med,
          x.hit,
          x.sd,
          x.min,
          x.max,
          source,
          known,
          JSON.stringify({
            source: "SMARTFUND_DERIVED",
            inputDomain: "STOCK_PRICE_HISTORY",
            historyStart: b[0]!.date.toISOString().slice(0, 10),
            historyEnd: asOf,
          }),
        );
    },
    { maxWait: 5000, timeout: 30000 },
  );
  return {
    status: "COMPLETE",
    rows: metrics.length,
    seasonality: sea.length,
    asOf,
    fingerprint,
    alignment: align,
    daily: metrics.filter((x) => x.tf === "DAILY").length,
    weekly: metrics.filter((x) => x.tf === "WEEKLY").length,
    monthly: metrics.filter((x) => x.tf === "MONTHLY").length,
  };
}
async function main() {
  const cp = await read<any>(cpFile, {
    cursor: "",
    processed: 0,
    success: 0,
    inputInsufficient: 0,
    failed: 0,
    retry: 0,
  });
  const stocks = await db.$queryRawUnsafe<any[]>(
    `SELECT s.id,s.ticker FROM stocks s WHERE s.exchange=$1 AND s.is_active=true AND s.status='ACTIVE' AND ($2::text IS NULL OR s.ticker=$2) AND ($2::text IS NOT NULL OR s.ticker>$3) AND EXISTS(SELECT 1 FROM stock_history h WHERE h.stock_id=s.id OFFSET 19 LIMIT 1) ORDER BY s.ticker LIMIT $4`,
    market,
    symbol,
    cp.cursor ?? "",
    limit,
  );
  let rows = 0,
    seasonality = 0;
  for (const s of stocks) {
    try {
      const r = await processStock(s);
      cp.processed++;
      if (r.status === "COMPLETE") {
        cp.success++;
        rows += r.rows;
        seasonality += r.seasonality;
      } else if (r.status === "INPUT_INSUFFICIENT") cp.inputInsufficient++;
      cp.cursor = s.ticker;
      cp.lastAsOf = r.asOf ?? cp.lastAsOf;
      cp.lastFingerprint = r.fingerprint ?? cp.lastFingerprint;
      cp.lastSuccess = now();
      await atomic(cpFile, {
        ...cp,
        market,
        currentStock: s.ticker,
        state: "RUNNING",
        calculationVersion: "TECHNICAL_V3",
        updatedAt: now(),
      });
      console.log(JSON.stringify({ ticker: s.ticker, ...r }));
    } catch (e) {
      cp.failed++;
      cp.retry++;
      cp.cursor = s.ticker;
      await atomic(cpFile, {
        ...cp,
        market,
        currentStock: s.ticker,
        state: "RETRY_WAIT",
        lastError: e instanceof Error ? e.message : String(e),
        updatedAt: now(),
      });
      console.error(
        JSON.stringify({
          ticker: s.ticker,
          status: "FAILED",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
  if (!stocks.length && cp.cursor) {
    cp.cursor = "";
    cp.cycles = (cp.cycles ?? 0) + 1;
  }
  await atomic(cpFile, {
    ...cp,
    market,
    currentStock: null,
    state: "SCHEDULED_WAIT",
    lastBatch: { stocks: stocks.length, rows, seasonality },
    updatedAt: now(),
  });
  console.log(
    JSON.stringify({
      status: "PASS",
      market,
      stocks: stocks.length,
      rows,
      seasonality,
      checkpoint: cp.cursor,
    }),
  );
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
