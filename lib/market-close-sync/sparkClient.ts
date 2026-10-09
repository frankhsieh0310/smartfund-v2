// Minimal Yahoo Spark batch client for market-close-sync. New file — does not touch or import the
// existing lib/services/dataProviders/yahoo/yahooClient.ts (that file is not modified by this
// feature). Same v7/finance/spark endpoint and 20-symbol hard limit already confirmed this session
// (smartmatch-spark-canary live tests, 2026-10-09).

import type { SparkCandle } from "./types";

export const SPARK_MAX_SYMBOLS_PER_BATCH = 20;

export type SparkBatchResult = {
  httpStatus: number;
  rateLimited: boolean; // true on 401/403/429 — caller must stop the whole run, not just this batch
  candles: SparkCandle[];
  error: string | null;
};

export async function fetchSparkBatch(symbols: string[]): Promise<SparkBatchResult> {
  if (symbols.length === 0 || symbols.length > SPARK_MAX_SYMBOLS_PER_BATCH) {
    throw new Error(`fetchSparkBatch: symbols.length must be 1..${SPARK_MAX_SYMBOLS_PER_BATCH}, got ${symbols.length}`);
  }
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.map(encodeURIComponent).join(",")}&range=5d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { httpStatus: res.status, rateLimited: true, candles: [], error: null };
    }
    const json = await res.json();
    const results = Array.isArray(json?.spark?.result) ? json.spark.result : [];
    const candles: SparkCandle[] = results.map((r: any) => {
      const resp = r?.response?.[0];
      const timestamps: number[] = Array.isArray(resp?.timestamp) ? resp.timestamp : [];
      const closes: Array<number | null> = Array.isArray(resp?.indicators?.quote?.[0]?.close) ? resp.indicators.quote[0].close : [];
      return {
        symbol: r?.symbol ?? "UNKNOWN",
        // Paired by index WITHIN one symbol's own two parallel arrays (Yahoo's own contract: one
        // response per symbol has matching-length timestamp[]/close[]) — never across symbols, and
        // never assumed to align with any other symbol's arrays, which is the actual misalignment
        // risk this session already confirmed (9047.HK silently dropping two interior days).
        points: timestamps.map((timestampUnix, i) => ({ timestampUnix, close: closes[i] ?? null })),
      };
    });
    return { httpStatus: res.status, rateLimited: false, candles, error: null };
  } catch (e) {
    return { httpStatus: 0, rateLimited: false, candles: [], error: String(e).slice(0, 300) };
  }
}
