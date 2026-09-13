// Global Index Data Platform — clones the proven FX/Stock/ETF Yahoo cloud pattern
// (lib/cron/fxUpdate.ts): Yahoo batch -> parse latest valid observation -> stale guard ->
// idempotent DB write -> checkpoint advance. Reuses the EXISTING canonical schema
// (global_index_registry / global_index_candles / global_index_snapshots) that
// lib/data-platform/web/indexService.ts already reads — no schema change, no new tables.
//
//   updateIndexQuotes()  — v7/finance/spark, ~20 indexes per HTTP call -> global_index_snapshots
//                          (intraday "latest level" only; never touches the daily candle table so
//                          an in-progress trading session never corrupts a finalized daily bar).
//   updateIndexHistory() — v8/finance/chart per index, incremental from last known candle ->
//                          global_index_candles (idempotent upsert, forward-only).
//
// Writes ONLY global_index_* tables. Never touches fx_*/stock/etf/fund tables or their cron files.
// Reuses lib/services/dataProviders/yahoo/yahooClient.ts's fetchYahooFxSpark/fetchYahooChartPeriod
// as-is (both are already generic multi-purpose Yahoo helpers despite the "Fx" name on the spark
// one — no new Yahoo client code needed).

import { prisma } from "@/lib/prisma";
import { fetchYahooFxSpark, fetchYahooChartPeriod } from "@/lib/services/dataProviders/yahoo/yahooClient";

// 2026-09-13 validation round: every existing global_index_registry row (166 total) checked
// individually against v7/finance/spark; symbols below returned a valid, correctly-identified
// (non-alias) response. ^TOPX (TOPIX) resolves to an unrelated MUTUALFUND instrument at Yahoo and
// is excluded — this matches the legacy scripts/data/index/run-global-index.ts's own
// "LICENSE_SOURCE_PENDING" annotation for the same symbol, a pre-existing, documented limitation,
// not a regression introduced here. ^TWOII (Taiwan OTC) has no Spark coverage but IS servable via
// Chart, so quote-phase treats it as best-effort (may show NO_NEW_DATA most runs) while history
// still covers it normally.
export const CORE_INDEX_SYMBOLS = [
  "^GSPC", "^IXIC", "^DJI", "^RUT", "^NYA", "^NDX", // US
  "^TWII", "^TWOII", // Taiwan
  "^N225", // Japan (TOPIX excluded, see above)
  "^HSI", "^HSCE", "000001.SS", "399001.SZ", "000300.SS", // HK/China
  "^KS11", "^KQ11", // Korea
  "^FTSE", "^GDAXI", "^FCHI", "^STOXX50E", "^STOXX", "^SSMI", "^IBEX", "FTSEMIB.MI", "^FTMC", "^AEX", "^MDAXI", // Europe
  "^AXJO", "^GSPTSE", // Australia/Canada
  "^NSEI", "^BSESN", "^STI", "^JKSE", "^KLSE", "^SET.BK", "PSEI.PS", // India/SEA
  "^BVSP", "^MXX", // Latam
  // Already-present, Yahoo-valid registry symbols kept in scope so this pipeline covers the
  // pre-existing universe too (Step 5: existing universe + core candidates -> validated union),
  // not just the newly-requested core list.
  "XU100.IS", "^TRCCRB", "^J203.JO", "^NYFANG", "^NZ50", "^OMX", "^SOX", "^RUI",
  "^SPG1200", "^TASI.SR", "DX-Y.NYB", "^VIX", "^VNINDEX.VN", "^W5000",
];

const DAY_MS = 86_400_000;

export type IndexQuoteBatchResult = {
  requestedIndexes: number;
  updatedIndexes: number;
  staleSkipped: number;
  noNewData: number;
  failedIndexes: Array<{ id: string; symbol: string; reason: string }>;
  lastId: string | null;
  wrapped: boolean;
};

// Phase 1: latest level. Bounded batch — Yahoo Spark's proven-safe cap for this endpoint is 20
// symbols/request (confirmed live 2026-09-13: 21+ symbols in one call returns HTTP 400 regardless
// of symbol validity; 20 is reliable), matching the FX pipeline's own batch size.
export async function updateIndexQuotes(cursor: string | null, batchSize = 20, symbols?: string[]): Promise<IndexQuoteBatchResult> {
  const scope = symbols ?? CORE_INDEX_SYMBOLS;
  const rows = await prisma.globalIndexRegistry.findMany({
    where: { active: true, symbol: { in: scope }, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: batchSize,
    select: { id: true, symbol: true },
  });
  const wrapped = rows.length < batchSize;
  if (rows.length === 0) return { requestedIndexes: 0, updatedIndexes: 0, staleSkipped: 0, noNewData: 0, failedIndexes: [], lastId: null, wrapped: true };

  const sparkResults = await fetchYahooFxSpark(rows.map((r) => r.symbol));
  const bySymbol = new Map(sparkResults.map((r) => [r.requestedSymbol, r]));

  const existing = await prisma.globalIndexSnapshot.findMany({ where: { indexId: { in: rows.map((r) => r.id) } }, select: { indexId: true, asOfDate: true } });
  const existingByIndex = new Map(existing.map((e) => [e.indexId, e.asOfDate]));

  let updatedIndexes = 0, staleSkipped = 0, noNewData = 0;
  const failedIndexes: Array<{ id: string; symbol: string; reason: string }> = [];

  for (const row of rows) {
    const r = bySymbol.get(row.symbol);
    if (!r || !r.ok || r.regularMarketPrice == null || !r.regularMarketTime) {
      failedIndexes.push({ id: row.id, symbol: row.symbol, reason: r ? "NO_VALID_PRICE" : "NOT_IN_RESPONSE" });
      continue;
    }
    const incomingAt = r.regularMarketTime;
    const existingAt = existingByIndex.get(row.id) ?? null;

    // Forward-only guard (Step 8): incoming < existing -> STALE_SKIP, incoming == existing ->
    // NO_NEW_DATA, incoming > existing -> UPDATED. A stale/late Yahoo response can never overwrite
    // a newer snapshot already in the DB.
    if (existingAt && incomingAt.getTime() < existingAt.getTime()) { staleSkipped++; continue; }
    if (existingAt && incomingAt.getTime() === existingAt.getTime()) { noNewData++; continue; }

    const change = r.previousClose != null ? r.regularMarketPrice - r.previousClose : null;
    const changePercent = change != null && r.previousClose ? (change / r.previousClose) * 100 : null;

    await prisma.globalIndexSnapshot.upsert({
      where: { indexId: row.id },
      create: { indexId: row.id, currentLevel: r.regularMarketPrice, previousClose: r.previousClose, change, changePercent, asOfDate: incomingAt, source: "YAHOO_SPARK", freshnessStatus: "CURRENT", verificationStatus: "UNVERIFIED", licenseStatus: "SUPPLEMENTAL_UNVERIFIED" },
      update: { currentLevel: r.regularMarketPrice, previousClose: r.previousClose, change, changePercent, asOfDate: incomingAt, source: "YAHOO_SPARK", freshnessStatus: "CURRENT" },
    });
    updatedIndexes++;
  }

  return { requestedIndexes: rows.length, updatedIndexes, staleSkipped, noNewData, failedIndexes, lastId: wrapped ? null : rows.at(-1)!.id, wrapped };
}

export type IndexHistoryBatchResult = {
  requestedIndexes: number;
  updatedIndexes: number;
  rowsWritten: number;
  failedIndexes: Array<{ id: string; symbol: string; reason: string }>;
  lastId: string | null;
  wrapped: boolean;
};

// Phase 2: daily history. Per index, incremental from the last known global_index_candles row
// (initial backfill ~1y; every rerun after that only asks Yahoo for [lastKnownDate - 3d, now], same
// padding-and-filter approach as the FX/stock/ETF price crons, so a same-day rerun never
// duplicates rows — the compound primary key (indexId, interval, timestamp, source) makes the
// upsert naturally idempotent).
export async function updateIndexHistory(cursor: string | null, batchSize = 2, symbols?: string[]): Promise<IndexHistoryBatchResult> {
  const scope = symbols ?? CORE_INDEX_SYMBOLS;
  const rows = await prisma.globalIndexRegistry.findMany({
    where: { active: true, symbol: { in: scope }, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: batchSize,
    select: { id: true, symbol: true, timezone: true, currency: true },
  });
  const wrapped = rows.length < batchSize;
  if (rows.length === 0) return { requestedIndexes: 0, updatedIndexes: 0, rowsWritten: 0, failedIndexes: [], lastId: null, wrapped: true };

  let updatedIndexes = 0, rowsWritten = 0;
  const failedIndexes: Array<{ id: string; symbol: string; reason: string }> = [];

  for (const row of rows) {
    try {
      const latestCandle = await prisma.globalIndexCandle.findFirst({
        where: { indexId: row.id, interval: "1d" },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      });
      const from = latestCandle ? new Date(latestCandle.timestamp.getTime() - 3 * DAY_MS) : new Date(Date.now() - 366 * DAY_MS);
      const to = new Date(Date.now() + DAY_MS);
      const chart = await Promise.race([
        fetchYahooChartPeriod(row.symbol, Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
      ]);
      const candles = (chart?.candles ?? []).filter((c) => c.close != null && c.close > 0 && c.high != null && c.low != null && c.open != null);
      if (!candles.length) { failedIndexes.push({ id: row.id, symbol: row.symbol, reason: "NO_CANDLES" }); continue; }

      const cursorTime = latestCandle?.timestamp.getTime() ?? null;
      let wrote = 0;
      for (const c of candles) {
        // Use Yahoo's raw bar timestamp as-is (matches the pre-existing global_index_candles
        // convention set by the legacy script — actual session-close time, e.g. 13:30:00Z for US
        // markets — NOT midnight-normalized). Normalizing to midnight here would mint a SECOND,
        // different primary key for the same trading day instead of matching the existing row,
        // producing duplicate same-day candles — caught live during targeted validation
        // (2026-09-13) before this ever reached production.
        const timestamp = c.date;
        // Forward-only for history too: never rewrite a day strictly before what we already have
        // beyond the 3-day revision-reabsorb window; same-day/future upserts stay idempotent.
        if (cursorTime != null && timestamp.getTime() < cursorTime - 3 * DAY_MS) continue;
        await prisma.globalIndexCandle.upsert({
          where: { indexId_interval_timestamp_source: { indexId: row.id, interval: "1d", timestamp, source: "YAHOO_CHART" } },
          create: {
            indexId: row.id, interval: "1d", timestamp, open: c.open!, high: c.high!, low: c.low!, close: c.close!,
            volume: c.volume != null ? c.volume : null, timezone: row.timezone ?? "UTC", session: "REGULAR",
            source: "YAHOO_CHART", completeness: "SOURCE_REPORTED", qualityStatus: "PASS",
            sourceType: "SUPPLEMENTAL", verificationStatus: "UNVERIFIED", licenseStatus: "SUPPLEMENTAL_UNVERIFIED",
            currency: row.currency, sourceUrl: `https://query1.finance.yahoo.com/v8/finance/chart/${row.symbol}`,
          },
          update: { open: c.open!, high: c.high!, low: c.low!, close: c.close!, volume: c.volume != null ? c.volume : null },
        });
        wrote++;
      }
      rowsWritten += wrote;
      updatedIndexes++;
    } catch (error) {
      failedIndexes.push({ id: row.id, symbol: row.symbol, reason: String(error) });
    }
  }

  return { requestedIndexes: rows.length, updatedIndexes, rowsWritten, failedIndexes, lastId: wrapped ? null : rows.at(-1)!.id, wrapped };
}
