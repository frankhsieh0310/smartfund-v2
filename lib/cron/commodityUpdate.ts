// SmartMatch Commodity Core Universe — Yahoo daily-close auto sync.
// Reuses the EXISTING canonical futures schema (futures_product_roots / commodity_identities /
// futures_root_market_observations) that the pre-existing Futures/Commodity work already
// populated for 15 of these 18 roots — this file only adds the missing daily incremental
// automation, not a second schema or a second history table.
//
//   updateCommodityHistory() — v8/finance/chart per commodity root, incremental only (short
//                              overlap window) -> futures_root_market_observations (idempotent
//                              upsert on the existing (yahoo_symbol, observed_date) unique key).
//
// Writes ONLY futures_root_market_observations rows for the 18 roots below. Never touches any
// other futures/commodity table, schema, or the separate (in-progress, out-of-scope) Futures Live
// Auto Sync workstream's own roots beyond this fixed Commodity Core Universe list.

import { prisma } from "@/lib/prisma";
import { fetchYahooChartPeriod } from "@/lib/services/dataProviders/yahoo/yahooClient";

const DAY_MS = 86_400_000;

// Fixed Commodity Core Universe (18 roots) — 15 already had mature Yahoo history in production;
// Brent/Live Cattle/Lean Hogs are the 3 gap-fills this round, using the exact yahoo_symbol already
// confirmed by the separate Futures identity-mapping work (BZ=F / LE=F / HE=F), live-reconfirmed
// 2026-09-16. root_id values are the commodity_identities-linked futures_product_roots row (this
// table has some unlinked/duplicate rows for the same root_symbol from earlier work; the id below
// is always the one with a real commodity_id, matching the ground-truth ingestion pattern already
// in place for the 15 working roots).
export const CORE_COMMODITY_ROOTS: Array<{ rootId: string; yahooSymbol: string; name: string }> = [
  { rootId: "ceebeb1f-3616-4d38-ab85-a7de76455d9a", yahooSymbol: "CL=F", name: "WTI Crude Oil" },
  { rootId: "8c9966ab-8e29-43bc-a4ff-e908fef9b2c2", yahooSymbol: "NG=F", name: "Natural Gas" },
  { rootId: "d57a0610-4fb7-4b0e-a7bf-ea52a299bbbf", yahooSymbol: "BZ=F", name: "Brent Crude" },
  { rootId: "35ff5db4-16ba-4392-a48e-efd96fbc485d", yahooSymbol: "GC=F", name: "Gold" },
  { rootId: "6ae35358-2b1c-4b3b-a09c-005b94e6b8cc", yahooSymbol: "SI=F", name: "Silver" },
  { rootId: "8f039a9d-b99f-4392-aa1f-7c5f2f7930f8", yahooSymbol: "HG=F", name: "Copper" },
  { rootId: "ae10e8e2-ff62-4b0c-a49f-ef7de91ce48e", yahooSymbol: "PL=F", name: "Platinum" },
  { rootId: "67b0dd24-c1b2-4fe2-aa46-7b9bc07c7caa", yahooSymbol: "PA=F", name: "Palladium" },
  { rootId: "fd09e876-d00b-4b83-a66c-b5fda200bda7", yahooSymbol: "ZC=F", name: "Corn" },
  { rootId: "f63f52c4-39cf-4f3f-a835-ad868d061ea4", yahooSymbol: "ZW=F", name: "Wheat" },
  { rootId: "d4a4304a-2c4d-47ff-acbc-a89d6c09342c", yahooSymbol: "ZS=F", name: "Soybeans" },
  { rootId: "7719c807-1b98-4a48-ade9-a6a199b448f6", yahooSymbol: "ZL=F", name: "Soybean Oil" },
  { rootId: "c9be301d-b1d0-4167-ad6d-bdd2114a8831", yahooSymbol: "KC=F", name: "Coffee" },
  { rootId: "34500588-c4e4-4fc9-ac32-72adfef22fed", yahooSymbol: "CC=F", name: "Cocoa" },
  { rootId: "b5fa20c5-38ea-44ae-a44f-205ebc938995", yahooSymbol: "SB=F", name: "Sugar" },
  { rootId: "cdd56574-85b6-4c42-aa76-2ab9eefd43a2", yahooSymbol: "CT=F", name: "Cotton" },
  { rootId: "17916524-f558-4f90-a51d-d0baaeda0bb3", yahooSymbol: "LE=F", name: "Live Cattle" },
  { rootId: "35a2935b-90d0-441b-adf3-e38baf08e654", yahooSymbol: "HE=F", name: "Lean Hogs" },
];

export type CommodityHistoryBatchResult = {
  requestedRoots: number;
  updatedRoots: number;
  rowsWritten: number;
  failedRoots: Array<{ rootId: string; symbol: string; reason: string }>;
  lastId: string | null;
  wrapped: boolean;
};

// Market-level incremental sync: one call, bounded loop over the fixed 18-root list, short
// overlap window per root (mirrors indexUpdate.ts/cryptoUpdate.ts's own proven approach) —
// never a full-history redownload. SOURCE_STATE <= DB_STATE -> no rows written for that root
// (NOOP); a single root's fetch/parse failure never blocks the others (try/catch per root).
export async function updateCommodityHistory(cursor: string | null, batchSize = 3, roots?: typeof CORE_COMMODITY_ROOTS): Promise<CommodityHistoryBatchResult> {
  const scope = roots ?? CORE_COMMODITY_ROOTS;
  const ordered = [...scope].sort((a, b) => a.rootId.localeCompare(b.rootId));
  const startIdx = cursor ? ordered.findIndex((r) => r.rootId > cursor) : 0;
  const rows = startIdx === -1 ? [] : ordered.slice(startIdx, startIdx + batchSize);
  const wrapped = rows.length < batchSize;
  if (rows.length === 0) return { requestedRoots: 0, updatedRoots: 0, rowsWritten: 0, failedRoots: [], lastId: null, wrapped: true };

  let updatedRoots = 0, rowsWritten = 0;
  const failedRoots: Array<{ rootId: string; symbol: string; reason: string }> = [];

  for (const root of rows) {
    try {
      const latest = await prisma.$queryRawUnsafe<Array<{ observed_date: Date }>>(
        `SELECT MAX(observed_date) AS observed_date FROM futures_root_market_observations WHERE root_id = $1::uuid`,
        root.rootId,
      );
      const latestDate = latest[0]?.observed_date ?? null;
      const from = latestDate ? new Date(latestDate.getTime() - 3 * DAY_MS) : new Date(Date.now() - 366 * DAY_MS);
      const to = new Date(Date.now() + DAY_MS);
      const chart = await Promise.race([
        fetchYahooChartPeriod(root.yahooSymbol, Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
      ]);
      const candles = (chart?.candles ?? []).filter((c) => c.close != null && c.close > 0 && c.high != null && c.low != null && c.open != null);
      if (!candles.length) { failedRoots.push({ rootId: root.rootId, symbol: root.yahooSymbol, reason: "NO_CANDLES" }); continue; }

      const cursorTime = latestDate ? latestDate.getTime() : null;
      let wrote = 0;
      for (const c of candles) {
        // Same raw-timestamp-as-source-truth rule already established for FX/Index/Crypto in this
        // codebase: use Yahoo's own daily bar timestamp (date-only for futures — the column is a
        // DATE, not a timestamptz) as-is, never re-derived, so a re-fetch of the same day always
        // upserts the same row instead of minting a duplicate.
        const observedDate = new Date(Date.UTC(c.date.getUTCFullYear(), c.date.getUTCMonth(), c.date.getUTCDate()));
        if (cursorTime != null && observedDate.getTime() < cursorTime - 3 * DAY_MS) continue;
        await prisma.$executeRawUnsafe(
          `INSERT INTO futures_root_market_observations
             (id, root_id, yahoo_symbol, observed_date, open, high, low, close, adjusted_close, volume, source, source_url, source_grain, retrieved_at, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2, $3::date, $4, $5, $6, $7, $8, $9, 'YAHOO_CHART', $10, 'DAILY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (yahoo_symbol, observed_date) DO UPDATE SET
             open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
             adjusted_close = EXCLUDED.adjusted_close, volume = EXCLUDED.volume,
             retrieved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
          root.rootId, root.yahooSymbol, observedDate.toISOString().slice(0, 10),
          c.open, c.high, c.low, c.close, c.adjClose ?? null, c.volume ?? null,
          `https://query1.finance.yahoo.com/v8/finance/chart/${root.yahooSymbol}`,
        );
        wrote++;
      }
      rowsWritten += wrote;
      updatedRoots++;
    } catch (error) {
      failedRoots.push({ rootId: root.rootId, symbol: root.yahooSymbol, reason: String(error) });
    }
  }

  return { requestedRoots: rows.length, updatedRoots, rowsWritten, failedRoots, lastId: wrapped ? null : rows.at(-1)!.rootId, wrapped };
}
