// Global Crypto Data Platform — clones the proven FX/Index Yahoo cloud pattern
// (lib/cron/indexUpdate.ts): Yahoo batch -> parse latest valid observation -> stale guard ->
// idempotent DB write -> checkpoint advance. Reuses the EXISTING canonical multi-exchange Crypto
// schema (crypto_assets / crypto_exchanges / crypto_markets / crypto_candles /
// crypto_market_snapshots / crypto_market_cap_supply / crypto_coverage) that already holds
// production Binance/Coinbase/Kraken/Bybit/OKX/Deribit/BitMEX data — Yahoo is added as ONE MORE
// exchange row (id="yahoo"), never touching the existing exchanges' markets/candles/snapshots.
//
//   ensureYahooCryptoUniverse() — idempotent upsert of the "yahoo" CryptoExchange and one
//                                 CryptoMarket per validated Yahoo symbol, resolving to an
//                                 EXISTING CryptoAsset by symbol where one already exists (so
//                                 BTC-USD/BTC-EUR-style multi-quote-currency Yahoo pairs never
//                                 mint a second "Bitcoin" canonical asset — Step 16's dedup rule).
//   updateCryptoQuotes()  — v7/finance/spark, ~20 symbols per HTTP call -> crypto_market_snapshots
//                           (price/volume/change; forward-only stale guard on observedAt).
//   updateCryptoHistory() — v8/finance/chart per market, incremental from last known candle ->
//                           crypto_candles (idempotent upsert, raw Yahoo timestamp — NOT
//                           midnight-normalized, learned live from the Index pipeline's own bug).
//   updateCryptoMarketCapSupply() — Yahoo's crypto screener endpoint (one call already returns
//                           marketCap + circulatingSupply + totalSupply for many symbols at once)
//                           -> crypto_market_cap_supply. Run far less often than quotes: this
//                           data moves slowly and the screener payload is heavier.
//
// Writes ONLY crypto_* tables, and only Yahoo-owned rows within them. Never touches fx/index/
// stock/etf/fund tables or the existing multi-exchange crypto ingestion scripts.

import { prisma } from "@/lib/prisma";
import { fetchYahooFxSpark, fetchYahooChartPeriod } from "@/lib/services/dataProviders/yahoo/yahooClient";

const YAHOO_EXCHANGE_ID = "yahoo";
const DAY_MS = 86_400_000;

// 2026-09-13 validation round: live-checked via Yahoo's crypto screener
// (v1/finance/screener/predefined/saved?scrIds=all_cryptocurrencies_us) which reports 8,245 total
// discoverable USD-quoted crypto symbols, paginated 250/page — a repeatable discovery method, not
// a one-off scrape. This round's active universe is bounded to the top-by-market-cap symbols
// (the screener sorts by intradaymarketcap DESC) actually needed for the requested targeted
// validation set, per Step 24's "targeted PoC before full run" guidance. All 16 requested symbols
// (majors + 2 stablecoins) confirmed present on page 1 and individually Yahoo-valid.
export const CORE_CRYPTO_SYMBOLS = [
  "BTC-USD", "ETH-USD", "USDT-USD", "BNB-USD", "XRP-USD", "SOL-USD", "USDC-USD", "DOGE-USD",
  "ADA-USD", "TRX-USD", "AVAX-USD", "LINK-USD", "DOT-USD", "LTC-USD", "BCH-USD", "SHIB-USD",
];

const marketIdFor = (symbol: string) => `yahoo-${symbol.toLowerCase()}`;
const assetIdFor = (base: string) => base.toLowerCase();

// Idempotent bootstrap: creates the "yahoo" exchange (once) and one crypto_markets row per
// symbol, resolving to an EXISTING crypto_assets row by symbol (case-insensitive) so Yahoo never
// mints a duplicate canonical asset for a coin the existing multi-exchange pipeline already
// tracks (e.g. BTC, ETH, USDT, USDC, DOGE, ADA, TRX, AVAX, DOT, LTC, BCH all pre-exist). Only
// genuinely new symbols (e.g. LINK, SHIB) get a new crypto_assets row.
export async function ensureYahooCryptoUniverse(symbols: string[] = CORE_CRYPTO_SYMBOLS) {
  await prisma.cryptoExchange.upsert({
    where: { id: YAHOO_EXCHANGE_ID },
    create: { id: YAHOO_EXCHANGE_ID, name: "Yahoo Finance", officialUrl: "https://finance.yahoo.com", spot: true, derivatives: false, sourceUrl: "https://query1.finance.yahoo.com" },
    update: {},
  });

  let created = 0, reusedAsset = 0, newAsset = 0;
  for (const symbol of symbols) {
    const [base] = symbol.split("-");
    const existing = await prisma.cryptoAsset.findFirst({ where: { symbol: { equals: base, mode: "insensitive" } }, select: { id: true } });
    let assetId = existing?.id;
    if (assetId) {
      reusedAsset++;
    } else {
      assetId = assetIdFor(base);
      await prisma.cryptoAsset.upsert({
        where: { id: assetId },
        create: { id: assetId, name: base, symbol: base, active: true, stablecoin: false, officialUrl: "https://finance.yahoo.com", sourceUrl: "https://query1.finance.yahoo.com", assetType: "CRYPTO", identitySource: "YAHOO" },
        update: {},
      });
      newAsset++;
    }
    await prisma.cryptoMarket.upsert({
      where: { id: marketIdFor(symbol) },
      create: { id: marketIdFor(symbol), exchangeId: YAHOO_EXCHANGE_ID, baseAssetId: assetId, quoteAssetId: null, providerSymbol: symbol, marketType: "SPOT", active: true },
      update: { active: true },
    });
    created++;
  }
  return { created, reusedAsset, newAsset };
}

export type CryptoQuoteBatchResult = {
  requestedMarkets: number;
  updatedMarkets: number;
  staleSkipped: number;
  noNewData: number;
  failedMarkets: Array<{ id: string; symbol: string; reason: string }>;
  lastId: string | null;
  wrapped: boolean;
};

// Phase 1: latest price. Bounded batch — live-confirmed 2026-09-13: Yahoo Spark's safe cap for
// crypto symbols is the same 20/request as FX and Index (21+ symbols in one call returns HTTP
// 400 regardless of validity).
export async function updateCryptoQuotes(cursor: string | null, batchSize = 20, symbols?: string[]): Promise<CryptoQuoteBatchResult> {
  // No explicit symbols -> drive from the full active "yahoo" universe already in crypto_markets
  // (mirrors FX's getActiveYahooDirectPairSymbols() DB-driven scope), not the original 16-symbol
  // targeted-validation constant.
  const rows = await prisma.cryptoMarket.findMany({
    where: { exchangeId: YAHOO_EXCHANGE_ID, active: true, ...(symbols ? { providerSymbol: { in: symbols } } : {}), ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: batchSize,
    select: { id: true, providerSymbol: true },
  });
  const wrapped = rows.length < batchSize;
  if (rows.length === 0) return { requestedMarkets: 0, updatedMarkets: 0, staleSkipped: 0, noNewData: 0, failedMarkets: [], lastId: null, wrapped: true };

  const sparkResults = await fetchYahooFxSpark(rows.map((r) => r.providerSymbol));
  const bySymbol = new Map(sparkResults.map((r) => [r.requestedSymbol, r]));

  const existing = await prisma.cryptoMarketSnapshot.findMany({ where: { marketId: { in: rows.map((r) => r.id) } }, select: { marketId: true, observedAt: true }, orderBy: { observedAt: "desc" } });
  const existingByMarket = new Map<string, Date>();
  for (const e of existing) if (!existingByMarket.has(e.marketId)) existingByMarket.set(e.marketId, e.observedAt);

  let updatedMarkets = 0, staleSkipped = 0, noNewData = 0;
  const failedMarkets: Array<{ id: string; symbol: string; reason: string }> = [];

  for (const row of rows) {
    const r = bySymbol.get(row.providerSymbol);
    if (!r || !r.ok || r.regularMarketPrice == null || !r.regularMarketTime) {
      failedMarkets.push({ id: row.id, symbol: row.providerSymbol, reason: r ? "NO_VALID_PRICE" : "NOT_IN_RESPONSE" });
      continue;
    }
    const incomingAt = r.regularMarketTime;
    const existingAt = existingByMarket.get(row.id) ?? null;

    // Forward-only guard (Step 8/11): crypto is 24/7, so this is the ONLY freshness signal that
    // matters here — no weekday/market-hours logic applies (Step 10).
    if (existingAt && incomingAt.getTime() < existingAt.getTime()) { staleSkipped++; continue; }
    if (existingAt && incomingAt.getTime() === existingAt.getTime()) { noNewData++; continue; }

    const change = r.previousClose != null ? r.regularMarketPrice - r.previousClose : null;
    const changePercent = change != null && r.previousClose ? (change / r.previousClose) * 100 : null;

    await prisma.cryptoMarketSnapshot.upsert({
      where: { marketId_observedAt: { marketId: row.id, observedAt: incomingAt } },
      create: { marketId: row.id, observedAt: incomingAt, price: r.regularMarketPrice, quoteCurrency: "USD", change24h: change, changePercent24h: changePercent, source: "YAHOO_SPARK", freshnessStatus: "CURRENT" },
      update: { price: r.regularMarketPrice, change24h: change, changePercent24h: changePercent, freshnessStatus: "CURRENT" },
    });
    updatedMarkets++;
  }

  return { requestedMarkets: rows.length, updatedMarkets, staleSkipped, noNewData, failedMarkets, lastId: wrapped ? null : rows.at(-1)!.id, wrapped };
}

export type CryptoHistoryBatchResult = {
  requestedMarkets: number;
  updatedMarkets: number;
  rowsWritten: number;
  failedMarkets: Array<{ id: string; symbol: string; reason: string }>;
  lastId: string | null;
  wrapped: boolean;
};

// Phase 2: daily history. Per market, incremental from the last known crypto_candles row — same
// 3-day revision-reabsorb padding as FX/Index. Crypto trades 24/7 (Step 9/19): the "1d" interval
// here is a fixed calendar-day bucket exactly as Yahoo's own chart API already returns it — no
// weekday/holiday filtering is applied anywhere in this function.
export async function updateCryptoHistory(cursor: string | null, batchSize = 2, symbols?: string[]): Promise<CryptoHistoryBatchResult> {
  // Same DB-driven default scope as updateCryptoQuotes above.
  const rows = await prisma.cryptoMarket.findMany({
    where: { exchangeId: YAHOO_EXCHANGE_ID, active: true, ...(symbols ? { providerSymbol: { in: symbols } } : {}), ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: batchSize,
    select: { id: true, providerSymbol: true },
  });
  const wrapped = rows.length < batchSize;
  if (rows.length === 0) return { requestedMarkets: 0, updatedMarkets: 0, rowsWritten: 0, failedMarkets: [], lastId: null, wrapped: true };

  let updatedMarkets = 0, rowsWritten = 0;
  const failedMarkets: Array<{ id: string; symbol: string; reason: string }> = [];

  for (const row of rows) {
    try {
      const latestCandle = await prisma.cryptoCandle.findFirst({
        where: { marketId: row.id, interval: "1d" },
        orderBy: { openTime: "desc" },
        select: { openTime: true },
      });
      const from = latestCandle ? new Date(latestCandle.openTime.getTime() - 3 * DAY_MS) : new Date(Date.now() - 366 * DAY_MS);
      const to = new Date(Date.now() + DAY_MS);
      const chart = await Promise.race([
        fetchYahooChartPeriod(row.providerSymbol, Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
      ]);
      const candles = (chart?.candles ?? []).filter((c) => c.close != null && c.close > 0 && c.high != null && c.low != null && c.open != null);
      if (!candles.length) { failedMarkets.push({ id: row.id, symbol: row.providerSymbol, reason: "NO_CANDLES" }); continue; }

      const cursorTime = latestCandle?.openTime.getTime() ?? null;
      let wrote = 0;
      for (const c of candles) {
        // Raw Yahoo bar timestamp, not midnight-normalized (see indexUpdate.ts's own comment on
        // this exact lesson — normalizing here would mint a second row for the same day instead
        // of upserting the existing one).
        const openTime = c.date;
        if (cursorTime != null && openTime.getTime() < cursorTime - 3 * DAY_MS) continue;
        await prisma.cryptoCandle.upsert({
          where: { marketId_interval_openTime: { marketId: row.id, interval: "1d", openTime } },
          create: { marketId: row.id, interval: "1d", openTime, closeTime: new Date(openTime.getTime() + DAY_MS - 1), open: c.open!, high: c.high!, low: c.low!, close: c.close!, volume: c.volume ?? 0, source: "YAHOO_CHART", freshnessStatus: "CURRENT" },
          update: { open: c.open!, high: c.high!, low: c.low!, close: c.close!, volume: c.volume ?? 0, freshnessStatus: "CURRENT" },
        });
        wrote++;
      }
      rowsWritten += wrote;
      updatedMarkets++;
    } catch (error) {
      failedMarkets.push({ id: row.id, symbol: row.providerSymbol, reason: String(error) });
    }
  }

  return { requestedMarkets: rows.length, updatedMarkets, rowsWritten, failedMarkets, lastId: wrapped ? null : rows.at(-1)!.id, wrapped };
}

// Phase 3: market cap / supply. Uses Yahoo's crypto screener (NOT Spark) since that's the only
// endpoint observed to return marketCap/circulatingSupply/totalSupply — Spark's meta does not
// include them (live-confirmed 2026-09-13). Intentionally separate from the OHLC candle table
// (Step 13) and run far less often than quotes since this data moves slowly.
export async function updateCryptoMarketCapSupply(symbols?: string[]) {
  const url = "https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=all_cryptocurrencies_us&count=250&offset=0";
  const res = await fetch(url, { headers: { "user-agent": "SmartFund-Crypto/1.0" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return { updated: 0, failed: symbols?.length ?? 0, error: `HTTP_${res.status}` };
  const body = (await res.json()) as { finance?: { result?: Array<{ quotes?: Array<Record<string, unknown>> }> } };
  const quotes = body.finance?.result?.[0]?.quotes ?? [];
  const bySymbol = new Map(quotes.map((q) => [q.symbol as string, q]));

  // This endpoint itself caps at 250 results (page-1-only, no genuine pagination — see the
  // full-universe discovery notes), so the default (no explicit symbols) matches against the
  // full active Yahoo universe rather than the original 16-symbol constant; only markets Yahoo's
  // top-250-by-market-cap screener actually returned will get updated either way.
  const markets = await prisma.cryptoMarket.findMany({ where: { exchangeId: YAHOO_EXCHANGE_ID, active: true, ...(symbols ? { providerSymbol: { in: symbols } } : {}) }, select: { baseAssetId: true, providerSymbol: true } });
  let updated = 0, failed = 0;
  const now = new Date();
  for (const m of markets) {
    const q = bySymbol.get(m.providerSymbol);
    const marketCap = q?.marketCap != null ? Number(q.marketCap) : null;
    const circulatingSupply = q?.circulatingSupply != null ? Number(q.circulatingSupply) : null;
    if (marketCap == null && circulatingSupply == null) { failed++; continue; }
    await prisma.cryptoMarketCapSupply.upsert({
      where: { assetId_observedAt: { assetId: m.baseAssetId, observedAt: now } },
      create: { assetId: m.baseAssetId, observedAt: now, marketCap, circulatingSupply, source: "YAHOO_SCREENER", freshnessStatus: "CURRENT" },
      update: { marketCap, circulatingSupply, freshnessStatus: "CURRENT" },
    });
    updated++;
  }
  return { updated, failed };
}
