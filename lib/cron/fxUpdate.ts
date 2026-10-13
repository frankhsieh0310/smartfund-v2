// FX Data Platform P0 — clones the proven Global Stock/ETF pattern (lib/cron/priceUpdate.ts,
// lib/yahoo/etfHistory.ts): Yahoo batch -> parse latest valid observation -> stale guard ->
// idempotent DB write -> checkpoint advance. Two phases, same shape as yahoo-etf's ?phase=:
//
//   updateFxQuotes()  — v7/finance/spark, ~20 pairs per HTTP call -> fx_latest_quotes
//   updateFxHistory() — v8/finance/chart per pair, incremental from last known candle -> fx_candles
//
// Writes ONLY fx_* tables. Never touches stocks/etfs/funds tables or their cron files.

import { prisma } from "@/lib/prisma";
import { fetchYahooFxSpark } from "@/lib/services/dataProviders/yahoo/yahooClient";
import { fetchYahooChartPeriod } from "@/lib/services/dataProviders/yahoo/yahooClient";
import { FX_PAIRS, canonicalPairId, getActiveYahooDirectPairSymbols } from "@/lib/cloud-ingestion/fxUniverse";

// 2026-09-12 full-universe round: production scope is now "every fx_pair tagged fx_coverage
// (capability=YAHOO_DIRECT, status=VALID)" — see getActiveYahooDirectPairSymbols() — not a
// hard-coded list. CURATED_SYMBOLS (the original 19-pair P0 scope) is kept ONLY as a smoke-test
// fixture: pass it explicitly via the `symbols` param when you want a fast, known-good check
// instead of the full validated universe.
export const CURATED_SYMBOLS = FX_PAIRS.map((p) => canonicalPairId(p.base, p.quote));

const DAY_MS = 86_400_000;
const dateOnly = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

export type FxQuoteBatchResult = {
  requestedPairs: number;
  resolvedPairs: number;
  updatedPairs: number;
  staleSkipped: number;
  noNewData: number;
  failedPairs: Array<{ symbol: string; reason: string }>;
  lastSymbol: string | null;
  wrapped: boolean;
};

// Phase 1: latest price. Bounded batch (default 20 pairs/request, matching the task's
// symbols_per_request≈20 guidance) via ONE spark call, not one call per pair.
// `symbols`: the working universe. Omit to use the full fx_coverage-validated Yahoo-direct
// universe (production default); pass CURATED_SYMBOLS for the 19-pair smoke test.
export async function updateFxQuotes(cursor: string | null, batchSize = 20, symbols?: string[]): Promise<FxQuoteBatchResult> {
  const scope = symbols ?? (await getActiveYahooDirectPairSymbols());
  const pairs = await prisma.fxPair.findMany({
    where: { active: true, symbol: { in: scope, ...(cursor ? { gt: cursor } : {}) } },
    orderBy: { symbol: "asc" },
    take: batchSize,
    select: { symbol: true },
  });
  const wrapped = pairs.length < batchSize;
  if (pairs.length === 0) return { requestedPairs: 0, resolvedPairs: 0, updatedPairs: 0, staleSkipped: 0, noNewData: 0, failedPairs: [], lastSymbol: null, wrapped: true };

  // Prefer the pre-existing "YAHOO_CHART" alias (populated 2026-08 for many majors) over our own
  // seed, so we never fork identity mapping for a pair the legacy build-out already resolved.
  const aliases = await prisma.fxPairAlias.findMany({
    where: { provider: { in: ["YAHOO_CHART", "YAHOO"] }, pairSymbol: { in: pairs.map((p) => p.symbol) } },
    select: { pairSymbol: true, providerSymbol: true, provider: true },
    orderBy: { provider: "asc" }, // "YAHOO" < "YAHOO_CHART" alphabetically; overwritten below so CHART wins
  });
  const aliasByPair = new Map(aliases.map((a) => [a.pairSymbol, a.providerSymbol]));
  const providerSymbols = pairs.map((p) => aliasByPair.get(p.symbol)).filter((s): s is string => !!s);

  const failedPairs: Array<{ symbol: string; reason: string }> = [];
  for (const p of pairs) if (!aliasByPair.has(p.symbol)) failedPairs.push({ symbol: p.symbol, reason: "NO_YAHOO_ALIAS" });

  const sparkResults = providerSymbols.length ? await fetchYahooFxSpark(providerSymbols) : [];
  const bySymbol = new Map(sparkResults.map((r) => [r.requestedSymbol, r]));

  let updatedPairs = 0, staleSkipped = 0, noNewData = 0;
  const existing = await prisma.fxLatestQuote.findMany({ where: { pairSymbol: { in: pairs.map((p) => p.symbol) } }, select: { pairSymbol: true, quotedAt: true } });
  const existingByPair = new Map(existing.map((e) => [e.pairSymbol, e.quotedAt]));

  for (const p of pairs) {
    const providerSymbol = aliasByPair.get(p.symbol);
    if (!providerSymbol) continue;
    const r = bySymbol.get(providerSymbol);
    if (!r || !r.ok || r.regularMarketPrice == null || !r.regularMarketTime) {
      failedPairs.push({ symbol: p.symbol, reason: r ? "NO_VALID_PRICE" : "NOT_IN_RESPONSE" });
      continue;
    }
    const incomingAt = r.regularMarketTime;
    const existingAt = existingByPair.get(p.symbol) ?? null;

    // Latest-price guard (Step 7): forward-only. incoming < existing -> STALE_SKIP,
    // incoming == existing -> NO_NEW_DATA, incoming > existing -> UPDATED. Never overwrite a
    // newer DB row with an older provider observation.
    if (existingAt && incomingAt.getTime() < existingAt.getTime()) { staleSkipped++; continue; }
    if (existingAt && incomingAt.getTime() === existingAt.getTime()) { noNewData++; continue; }

    await prisma.fxLatestQuote.upsert({
      where: { pairSymbol: p.symbol },
      create: { pairSymbol: p.symbol, mid: r.regularMarketPrice, source: "YAHOO_SPARK", quotedAt: incomingAt, metadata: { providerSymbol, canonicalSymbol: r.canonicalSymbol, previousClose: r.previousClose } },
      update: { mid: r.regularMarketPrice, source: "YAHOO_SPARK", quotedAt: incomingAt, ingestedAt: new Date(), metadata: { providerSymbol, canonicalSymbol: r.canonicalSymbol, previousClose: r.previousClose } },
    });
    updatedPairs++;
  }

  return { requestedPairs: pairs.length, resolvedPairs: sparkResults.filter((r) => r.ok).length, updatedPairs, staleSkipped, noNewData, failedPairs, lastSymbol: wrapped ? null : pairs.at(-1)!.symbol, wrapped };
}

export type FxHistoryBatchResult = {
  requestedPairs: number;
  updatedPairs: number;
  rowsWritten: number;
  failedPairs: Array<{ symbol: string; reason: string }>;
  lastSymbol: string | null;
  wrapped: boolean;
};

// Phase 2: daily history. Per pair, incremental from the last known fx_candles row (initial
// backfill uses ~1y; every rerun after that only asks Yahoo for [lastKnownDate - 3d, now], same
// padding-and-filter approach as lib/cron/priceUpdate.ts, so a same-day rerun never duplicates rows
// (fx_candles PK is [pairSymbol, interval, openTime, source] -> upsert is naturally idempotent).
export async function updateFxHistory(cursor: string | null, batchSize = 20, symbols?: string[]): Promise<FxHistoryBatchResult> {
  const scope = symbols ?? (await getActiveYahooDirectPairSymbols());
  const pairs = await prisma.fxPair.findMany({
    where: { active: true, symbol: { in: scope, ...(cursor ? { gt: cursor } : {}) } },
    orderBy: { symbol: "asc" },
    take: batchSize,
    select: { symbol: true },
  });
  const wrapped = pairs.length < batchSize;
  if (pairs.length === 0) return { requestedPairs: 0, updatedPairs: 0, rowsWritten: 0, failedPairs: [], lastSymbol: null, wrapped: true };

  const aliases = await prisma.fxPairAlias.findMany({
    where: { provider: { in: ["YAHOO_CHART", "YAHOO"] }, pairSymbol: { in: pairs.map((p) => p.symbol) } },
    select: { pairSymbol: true, providerSymbol: true },
    orderBy: { provider: "asc" },
  });
  const aliasByPair = new Map(aliases.map((a) => [a.pairSymbol, a.providerSymbol]));

  let updatedPairs = 0, rowsWritten = 0;
  const failedPairs: Array<{ symbol: string; reason: string }> = [];

  for (const p of pairs) {
    const providerSymbol = aliasByPair.get(p.symbol);
    if (!providerSymbol) { failedPairs.push({ symbol: p.symbol, reason: "NO_YAHOO_ALIAS" }); continue; }
    try {
      const latestCandle = await prisma.fxCandle.findFirst({
        where: { pairSymbol: p.symbol, interval: "1d", source: "YAHOO_CHART" },
        orderBy: { openTime: "desc" },
        select: { openTime: true },
      });
      // Initial backfill: ~1y. Incremental: from the last known day (minus 3d padding, same as
      // stock/ETF price cron, to reabsorb any Yahoo revisions to the last couple of sessions).
      const from = latestCandle ? new Date(latestCandle.openTime.getTime() - 3 * DAY_MS) : new Date(Date.now() - 366 * DAY_MS);
      const to = new Date(Date.now() + DAY_MS);
      // fetchYahooChartPeriod is shared with the stock/ETF price cron (lib/cron/priceUpdate.ts) so
      // it isn't touched here (out of scope). It also has no internal fetch timeout — a stalled
      // Yahoo connection was observed live to hang this call indefinitely during full-universe
      // backfill testing, so bound it locally instead of patching the shared helper.
      const chart = await Promise.race([
        fetchYahooChartPeriod(providerSymbol, Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
      ]);
      const candles = (chart?.candles ?? []).filter((c) => c.close != null && c.close > 0 && c.high != null && c.low != null && c.open != null);
      if (!candles.length) { failedPairs.push({ symbol: p.symbol, reason: "NO_CANDLES" }); continue; }

      const cursorTime = latestCandle?.openTime.getTime() ?? null;
      let wrote = 0;
      for (const row of candles) {
        const openTime = dateOnly(row.date);
        // Forward-only for history too: never rewrite a day strictly before what we already have
        // (the upsert below is idempotent for openTime >= cursor; this just skips the padding rows
        // Yahoo returns that fall before the requested window's true start).
        if (cursorTime != null && openTime.getTime() < cursorTime - 3 * DAY_MS) continue;
        await prisma.fxCandle.upsert({
          where: { pairSymbol_interval_openTime_source: { pairSymbol: p.symbol, interval: "1d", openTime, source: "YAHOO_CHART" } },
          create: { pairSymbol: p.symbol, interval: "1d", openTime, closeTime: new Date(openTime.getTime() + DAY_MS - 1), open: row.open!, high: row.high!, low: row.low!, close: row.close!, mid: row.close!, source: "YAHOO_CHART", providerSymbol, sourceUrl: `https://query1.finance.yahoo.com/v8/finance/chart/${providerSymbol}` },
          update: { open: row.open!, high: row.high!, low: row.low!, close: row.close!, mid: row.close! },
        });
        wrote++;
      }
      rowsWritten += wrote;
      updatedPairs++;

      const latest = candles.at(-1)!;
      await prisma.fxCoverage.upsert({
        where: { pairSymbol_capability_interval: { pairSymbol: p.symbol, capability: "DAILY_HISTORY", interval: "1d" } },
        create: { pairSymbol: p.symbol, capability: "DAILY_HISTORY", interval: "1d", status: "ACTIVE", provider: "YAHOO", latestAt: dateOnly(latest.date), rowCount: wrote, qualityStatus: "OK" },
        update: { status: "ACTIVE", latestAt: dateOnly(latest.date), rowCount: { increment: wrote }, qualityStatus: "OK", checkedAt: new Date() },
      });
    } catch (error) {
      failedPairs.push({ symbol: p.symbol, reason: String(error) });
    }
  }

  return { requestedPairs: pairs.length, updatedPairs, rowsWritten, failedPairs, lastSymbol: wrapped ? null : pairs.at(-1)!.symbol, wrapped };
}
