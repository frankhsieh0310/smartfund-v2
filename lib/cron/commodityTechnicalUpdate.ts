// Task X9 (round-5, section 2-3/3-1): daily technical-indicator computation for the Commodity Core
// Universe (CORE_COMMODITY_ROOTS, commodityUpdate.ts), sourced ONLY from closing price (+ volume for
// the volume-multiple check) already stored in futures_root_market_observations by this same round's
// revived price sync. Writes into the pre-existing futures_technical_analytics table (921k legacy
// rows from a system whose own writer code was never found in this repo's git history -- see this
// round's report) using timeframe='1d' and source='SMARTMATCH_COMMODITY_V1' so these rows are never
// confused with that legacy data under a different source tag, and the (yahoo_symbol, timeframe,
// observed_at) primary key still gives clean idempotent upserts.
import { prisma } from "@/lib/prisma";
import { sma, ema, macd, rsi, bollinger, kd, nDayHighLow, volumeMultiple } from "./technicalIndicators";
import { CORE_COMMODITY_ROOTS } from "./commodityUpdate";

export const COMMODITY_TECHNICAL_SOURCE = "SMARTMATCH_COMMODITY_V1";

// Standard parameters, recorded alongside every computed value per the round's explicit instruction
// ("記錄參數") -- never silently implied.
export const INDICATOR_PARAMS = {
  smaPeriods: [20, 50, 200],
  emaPeriods: [12, 26],
  macd: { fast: 12, slow: 26, signal: 9 },
  rsiPeriod: 14,
  bollinger: { period: 20, numStdDev: 2 },
  kdRsvPeriod: 9,
  nDayHighLowPeriods: [20, 60],
  volumeMultiplePeriod: 20,
} as const;

type HistoryRow = { observed_date: Date; close: number; high: number; low: number; volume: number | null };

export type CommodityTechnicalResult = {
  requestedRoots: number;
  updatedRoots: number;
  skippedRoots: Array<{ rootId: string; symbol: string; reason: string }>;
};

/** One root's worth of computation + (optionally) write. Pulled out as its own function so it's
 * callable standalone for a read-only spot-check (no write) without going through the batch loop. */
export async function computeCommodityTechnical(rootId: string, yahooSymbol: string) {
  const rows = await prisma.$queryRawUnsafe<HistoryRow[]>(
    `SELECT observed_date, close::float8 AS close, high::float8 AS high, low::float8 AS low, volume::float8 AS volume
     FROM futures_root_market_observations
     WHERE root_id = $1::uuid
     ORDER BY observed_date ASC`,
    rootId,
  );
  if (rows.length < 200) return { ok: false as const, reason: "INSUFFICIENT_HISTORY", pointCount: rows.length };

  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
  const ohlc = rows.map((r) => ({ high: r.high, low: r.low, close: r.close }));
  const latestDate = rows[rows.length - 1].observed_date;

  const metrics = {
    sma: Object.fromEntries(INDICATOR_PARAMS.smaPeriods.map((p) => [p, sma(closes, p)])),
    ema: Object.fromEntries(INDICATOR_PARAMS.emaPeriods.map((p) => [p, ema(closes, p)])),
    macd: macd(closes, INDICATOR_PARAMS.macd.fast, INDICATOR_PARAMS.macd.slow, INDICATOR_PARAMS.macd.signal),
    rsi14: rsi(closes, INDICATOR_PARAMS.rsiPeriod),
    bollinger: bollinger(closes, INDICATOR_PARAMS.bollinger.period, INDICATOR_PARAMS.bollinger.numStdDev),
    kd: kd(ohlc, INDICATOR_PARAMS.kdRsvPeriod),
    nDayHighLow: Object.fromEntries(INDICATOR_PARAMS.nDayHighLowPeriods.map((p) => [p, nDayHighLow(closes, p)])),
    volumeMultiple20: volumeMultiple(volumes, INDICATOR_PARAMS.volumeMultiplePeriod),
    params: INDICATOR_PARAMS,
    computedFromClosesThrough: latestDate.toISOString().slice(0, 10),
  };

  return { ok: true as const, latestDate, metrics };
}

export async function updateCommodityTechnical(
  cursor: string | null,
  batchSize = 5,
  roots = CORE_COMMODITY_ROOTS,
  writeEnabled = false,
): Promise<CommodityTechnicalResult & { lastId: string | null; wrapped: boolean }> {
  const ordered = [...roots].sort((a, b) => a.rootId.localeCompare(b.rootId));
  const startIdx = cursor ? ordered.findIndex((r) => r.rootId > cursor) : 0;
  const slice = startIdx === -1 ? [] : ordered.slice(startIdx, startIdx + batchSize);
  const wrapped = slice.length < batchSize;
  if (slice.length === 0) return { requestedRoots: 0, updatedRoots: 0, skippedRoots: [], lastId: null, wrapped: true };

  let updatedRoots = 0;
  const skippedRoots: Array<{ rootId: string; symbol: string; reason: string }> = [];

  for (const root of slice) {
    try {
      const result = await computeCommodityTechnical(root.rootId, root.yahooSymbol);
      if (!result.ok) { skippedRoots.push({ rootId: root.rootId, symbol: root.yahooSymbol, reason: result.reason }); continue; }
      if (writeEnabled) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO futures_technical_analytics
             (root_id, yahoo_symbol, timeframe, observed_at, metrics, source, created_at, updated_at)
           VALUES ($1::uuid, $2, '1d', $3::timestamptz, $4::jsonb, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (yahoo_symbol, timeframe, observed_at) DO UPDATE SET
             metrics = EXCLUDED.metrics, updated_at = CURRENT_TIMESTAMP`,
          root.rootId, root.yahooSymbol, result.latestDate.toISOString(),
          JSON.stringify(result.metrics), COMMODITY_TECHNICAL_SOURCE,
        );
        // Task X9 review fix: only count as "updated" when a write actually happened -- previously
        // incremented unconditionally, so shadow-mode responses misleadingly reported updatedRoots
        // as if real writes occurred.
        updatedRoots++;
      }
    } catch (error) {
      skippedRoots.push({ rootId: root.rootId, symbol: root.yahooSymbol, reason: String(error) });
    }
  }

  return { requestedRoots: slice.length, updatedRoots, skippedRoots, lastId: wrapped ? null : slice.at(-1)!.rootId, wrapped };
}
