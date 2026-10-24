// Daily incremental refresh for stock_technical. This is a DIFFERENT job from
// scripts/data/technical/run-production-stock-technical.ts, which only BACKFILLS stocks that have
// ZERO stock_technical rows (`NOT EXISTS stock_technical`) -- confirmed by reading that script's
// own candidate query. That explains why TW's 99.99%-covered stocks went 3 months stale: nothing
// was ever wired to REFRESH a stock once it already had rows. This file computes the formulas
// identically (same SMA/EMA/MACD/RSI14/ATR14/KD/Bollinger math, copied verbatim from that script
// so the two never drift) but targets stocks whose latest stock_technical date is BEHIND their
// latest stock_history date, and only (re)computes/upserts the missing trailing dates.
//
// TW scope only this round (exchange IN ('TWSE','TPEx')) -- the other markets
// run-production-stock-technical.ts supports (JPX/KSC/KOE/HKG/SHH/SHZ/SES/TOR/NEO/VAN/CNQ/PAR)
// are NOT wired into this daily refresh yet; disclosed gap, not silently assumed done.
import { prisma } from "@/lib/prisma";

export type TechnicalRow = {
  date: string; ma5: number | null; ma20: number | null; ma60: number | null; ma120: number | null; ma240: number | null;
  ema12: number | null; ema26: number | null; macd: number | null; macdSignal: number | null; macdHistogram: number | null;
  kdK: number | null; kdD: number | null; rsi14: number | null; atr14: number | null;
  bollingerUpper: number | null; bollingerMiddle: number | null; bollingerLower: number | null;
};

const finite = (value: number | null): number | null => (value !== null && Number.isFinite(value) ? Number(value.toFixed(8)) : null);

function sma(values: number[], end: number, period: number): number | null {
  if (end + 1 < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i += 1) sum += values[i]!;
  return sum / period;
}
function ema(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return out;
  out[period - 1] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) out[i] = (values[i]! - out[i - 1]!) * k + out[i - 1]!;
  return out;
}
function signal(values: Array<number | null>, period = 9): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  const first = values.findIndex((v) => v !== null);
  if (first < 0 || values.length - first < period) return out;
  out[first + period - 1] = (values.slice(first, first + period) as number[]).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = first + period; i < values.length; i += 1) out[i] = (values[i]! - out[i - 1]!) * k + out[i - 1]!;
  return out;
}
function rsi(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i += 1) { const c = values[i]! - values[i - 1]!; gains += Math.max(c, 0); losses += Math.max(-c, 0); }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const c = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(c, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-c, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
function atr(high: number[], low: number[], close: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = Array(close.length).fill(null);
  if (close.length < period) return out;
  const tr = close.map((_, i) => (i === 0 ? high[i]! - low[i]! : Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!))));
  let current = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = current;
  for (let i = period; i < close.length; i += 1) { current = (current * (period - 1) + tr[i]!) / period; out[i] = current; }
  return out;
}
function kd(high: number[], low: number[], close: number[]): { k: Array<number | null>; d: Array<number | null> } {
  const k: Array<number | null> = Array(close.length).fill(null), d: Array<number | null> = Array(close.length).fill(null);
  let previousK = 50, previousD = 50;
  for (let i = 8; i < close.length; i += 1) {
    const highest = Math.max(...high.slice(i - 8, i + 1)), lowest = Math.min(...low.slice(i - 8, i + 1));
    const rsv = highest === lowest ? 50 : ((close[i]! - lowest) / (highest - lowest)) * 100;
    previousK = (previousK * 2 + rsv) / 3; previousD = (previousD * 2 + previousK) / 3;
    k[i] = previousK; d[i] = previousD;
  }
  return { k, d };
}
function bands(values: number[], end: number): { middle: number | null; upper: number | null; lower: number | null } {
  const middle = sma(values, end, 20);
  if (middle === null) return { middle: null, upper: null, lower: null };
  let variance = 0;
  for (let i = end - 19; i <= end; i += 1) variance += (values[i]! - middle) ** 2;
  const deviation = Math.sqrt(variance / 20);
  return { middle, upper: middle + 2 * deviation, lower: middle - 2 * deviation };
}

export type PricePoint = { date: Date; high: number | null; low: number | null; close: number };

/** Computes one TechnicalRow per valid price point (same shape/formulas as
 * run-production-stock-technical.ts's calculate()). Caller decides which trailing subset to keep
 * (e.g. only dates after the stock's current latest stock_technical date). */
export function computeTechnicalSeries(prices: PricePoint[]): TechnicalRow[] {
  const valid = prices.filter((p) => p.high !== null && p.low !== null);
  const close = valid.map((p) => p.close), high = valid.map((p) => p.high!), low = valid.map((p) => p.low!);
  const ema12 = ema(close, 12), ema26 = ema(close, 26);
  const macd = close.map((_, i) => (ema12[i] !== null && ema26[i] !== null ? ema12[i]! - ema26[i]! : null));
  const macdSignal = signal(macd), rsi14 = rsi(close), atr14 = atr(high, low, close), stochastic = kd(high, low, close);
  return valid.flatMap((price, i) => {
    if (i < 4) return [];
    const bollinger = bands(close, i);
    return [{
      date: price.date.toISOString().slice(0, 10),
      ma5: finite(sma(close, i, 5)), ma20: finite(sma(close, i, 20)), ma60: finite(sma(close, i, 60)),
      ma120: finite(sma(close, i, 120)), ma240: finite(sma(close, i, 240)), ema12: finite(ema12[i]), ema26: finite(ema26[i]),
      macd: finite(macd[i]), macdSignal: finite(macdSignal[i]),
      macdHistogram: finite(macd[i] !== null && macdSignal[i] !== null ? macd[i]! - macdSignal[i]! : null),
      kdK: finite(stochastic.k[i]), kdD: finite(stochastic.d[i]), rsi14: finite(rsi14[i]), atr14: finite(atr14[i]),
      bollingerUpper: finite(bollinger.upper), bollingerMiddle: finite(bollinger.middle), bollingerLower: finite(bollinger.lower),
    }];
  });
}

export type StaleStock = { id: string; ticker: string; latestTechnicalDate: string | null };

/** Stocks whose stock_history has a date newer than their stock_technical -- i.e. genuinely
 * behind, not just "never computed" (that's the other script's job). `countries` scopes the
 * market (e.g. ['TW'] or ['US']) -- kept as a parameter instead of two near-duplicate functions
 * so TW and US share one query/index path. */
async function findStaleStocksByCountry(countries: string[], limit: number, afterTicker: string | null): Promise<StaleStock[]> {
  return prisma.$queryRawUnsafe<StaleStock[]>(
    `SELECT s.id, s.ticker, (SELECT MAX(t.date)::text FROM stock_technical t WHERE t.stock_id = s.id) AS "latestTechnicalDate"
       FROM stocks s
      WHERE s.is_active AND s.country = ANY($3::text[]) AND s.ticker > $2
        AND EXISTS (
          SELECT 1 FROM stock_history h WHERE h.stock_id = s.id
            AND h.date > COALESCE((SELECT MAX(t.date) FROM stock_technical t WHERE t.stock_id = s.id), '1900-01-01'::date)
        )
      ORDER BY s.ticker ASC
      LIMIT $1`,
    limit, afterTicker ?? "", countries,
  );
}

export async function findStaleTwStocks(limit: number, afterTicker: string | null): Promise<StaleStock[]> {
  return findStaleStocksByCountry(["TW"], limit, afterTicker);
}

/** Same as findStaleTwStocks, scoped to US-listed stocks (NASDAQ/NYSE/AMEX etc., country='US') --
 * 2026-10-24（選股反查第一階段）: stock-technical-daily 本來只做 TW，美股完全沒有每日更新，
 * 確認AAPL停在2026-08-14（約2.5個月前）——不是「全部都停」，是美股從來沒被排進這支cron。 */
export async function findStaleUsStocks(limit: number, afterTicker: string | null): Promise<StaleStock[]> {
  return findStaleStocksByCountry(["US"], limit, afterTicker);
}

/** Fetches enough trailing price history (240+ bars for MA240) to recompute correctly, then
 * upserts only the rows strictly after `sinceDate` (null = upsert everything, used for a stock
 * that has zero prior technical rows reached via this path, which shouldn't normally happen since
 * that's the backfill script's job, but handled safely regardless). */
export async function refreshStockTechnical(stockId: string, sinceDate: string | null, writeEnabled: boolean): Promise<{ rowsComputed: number; rowsWritten: number }> {
  const history = await prisma.$queryRawUnsafe<{ date: Date; high: string | null; low: string | null; close: string }[]>(
    `SELECT date, high::text, low::text, close::text FROM stock_history WHERE stock_id = $1 ORDER BY date ASC`,
    stockId,
  );
  const prices: PricePoint[] = history.map((h) => ({ date: h.date, high: h.high !== null ? Number(h.high) : null, low: h.low !== null ? Number(h.low) : null, close: Number(h.close) }));
  const allRows = computeTechnicalSeries(prices);
  const newRows = sinceDate ? allRows.filter((r) => r.date > sinceDate) : allRows;
  if (!writeEnabled || newRows.length === 0) return { rowsComputed: allRows.length, rowsWritten: 0 };

  for (let offset = 0; offset < newRows.length; offset += 2000) {
    const chunk = newRows.slice(offset, offset + 2000).map((r) => ({ ...r, id: crypto.randomUUID() }));
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_technical (id,stock_id,date,ma5,ma20,ma60,ma120,ma240,ema12,ema26,macd,macd_signal,macd_histogram,kd_k,kd_d,rsi14,atr14,bollinger_upper,bollinger_middle,bollinger_lower)
       SELECT value->>'id',$1,(value->>'date')::date,NULLIF(value->>'ma5','')::numeric,NULLIF(value->>'ma20','')::numeric,NULLIF(value->>'ma60','')::numeric,NULLIF(value->>'ma120','')::numeric,NULLIF(value->>'ma240','')::numeric,NULLIF(value->>'ema12','')::numeric,NULLIF(value->>'ema26','')::numeric,NULLIF(value->>'macd','')::numeric,NULLIF(value->>'macdSignal','')::numeric,NULLIF(value->>'macdHistogram','')::numeric,NULLIF(value->>'kdK','')::numeric,NULLIF(value->>'kdD','')::numeric,NULLIF(value->>'rsi14','')::numeric,NULLIF(value->>'atr14','')::numeric,NULLIF(value->>'bollingerUpper','')::numeric,NULLIF(value->>'bollingerMiddle','')::numeric,NULLIF(value->>'bollingerLower','')::numeric
         FROM jsonb_array_elements($2::jsonb) value
       ON CONFLICT (stock_id,date) DO UPDATE SET ma5=EXCLUDED.ma5,ma20=EXCLUDED.ma20,ma60=EXCLUDED.ma60,ma120=EXCLUDED.ma120,ma240=EXCLUDED.ma240,ema12=EXCLUDED.ema12,ema26=EXCLUDED.ema26,macd=EXCLUDED.macd,macd_signal=EXCLUDED.macd_signal,macd_histogram=EXCLUDED.macd_histogram,kd_k=EXCLUDED.kd_k,kd_d=EXCLUDED.kd_d,rsi14=EXCLUDED.rsi14,atr14=EXCLUDED.atr14,bollinger_upper=EXCLUDED.bollinger_upper,bollinger_middle=EXCLUDED.bollinger_middle,bollinger_lower=EXCLUDED.bollinger_lower`,
      stockId, JSON.stringify(chunk),
    );
  }
  return { rowsComputed: allRows.length, rowsWritten: newRows.length };
}
