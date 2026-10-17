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

// Task X10 (round-6 instruction 一-2): expanded from the original 18+5=23 to every genuine physical
// commodity continuous-contract (`=F`) Yahoo symbol found in futures_yahoo_symbol_mappings, verified
// one-by-one against futures_product_roots to exclude anything that isn't an actual commodity (the
// 831-row mapping table also covers Treasury/rate futures, equity-index futures, single-stock
// futures, FX futures and crypto-proxy futures -- none of those belong here). Also fixes a real bug
// found during this expansion: the ORIGINAL Brent/Live Cattle/Lean Hogs root_ids (from the upstream
// release-data-p3 commit) each pointed at a near-empty duplicate root (12 rows, or 0 for Lean Hogs)
// instead of the correct root with thousands of rows of real history -- futures_product_roots has
// known unlinked duplicate rows per root_symbol from earlier work, and the original commit picked
// the wrong one for these 3. Verified via a direct row-count query against
// futures_root_market_observations before swapping in the correct root_ids below.
export const CORE_COMMODITY_ROOTS: Array<{ rootId: string; yahooSymbol: string; name: string }> = [
  { rootId: "ceebeb1f-3616-4d38-ab85-a7de76455d9a", yahooSymbol: "CL=F", name: "WTI Crude Oil" },
  { rootId: "8c9966ab-8e29-43bc-a4ff-e908fef9b2c2", yahooSymbol: "NG=F", name: "Natural Gas" },
  // Brent: was d57a0610... (12 rows) -- corrected to 7ceb9102... (4,759 rows, latest 2026-09-11).
  { rootId: "7ceb9102-ff27-4040-a181-26aaabbd6193", yahooSymbol: "BZ=F", name: "Brent Crude" },
  { rootId: "35ff5db4-16ba-4392-a48e-efd96fbc485d", yahooSymbol: "GC=F", name: "Gold" },
  { rootId: "6ae35358-2b1c-4b3b-a09c-005b94e6b8cc", yahooSymbol: "SI=F", name: "Silver" },
  { rootId: "8f039a9d-b99f-4392-aa1f-7c5f2f7930f8", yahooSymbol: "HG=F", name: "Copper" },
  { rootId: "ae10e8e2-ff62-4b0c-a49f-ef7de91ce48e", yahooSymbol: "PL=F", name: "Platinum" },
  { rootId: "67b0dd24-c1b2-4fe2-aa46-7b9bc07c7caa", yahooSymbol: "PA=F", name: "Palladium" },
  { rootId: "fd09e876-d00b-4b83-a66c-b5fda200bda7", yahooSymbol: "ZC=F", name: "Corn" },
  { rootId: "f63f52c4-39cf-4f3f-a835-ad868d061ea4", yahooSymbol: "ZW=F", name: "Wheat (Chicago SRW)" },
  // New (Task X10): a second, distinct wheat contract -- Kansas HRW wheat is priced differently from
  // Chicago SRW wheat and both trade actively; not a duplicate of ZW=F above.
  { rootId: "553b2e4d-d509-428f-a970-1fa01dca62b2", yahooSymbol: "KE=F", name: "Wheat (Kansas HRW)" },
  { rootId: "d4a4304a-2c4d-47ff-acbc-a89d6c09342c", yahooSymbol: "ZS=F", name: "Soybeans" },
  { rootId: "7719c807-1b98-4a48-ade9-a6a199b448f6", yahooSymbol: "ZL=F", name: "Soybean Oil" },
  // New (Task X10): confirmed genuine commodity (commodity_group AGRICULTURE), has a verified Yahoo
  // mapping, was simply missed in the original 18-root list.
  { rootId: "c1ec80c8-16c6-4493-a934-14fb9c9ae783", yahooSymbol: "ZM=F", name: "Soybean Meal" },
  { rootId: "c9be301d-b1d0-4167-ad6d-bdd2114a8831", yahooSymbol: "KC=F", name: "Coffee" },
  { rootId: "34500588-c4e4-4fc9-ac32-72adfef22fed", yahooSymbol: "CC=F", name: "Cocoa" },
  { rootId: "b5fa20c5-38ea-44ae-a44f-205ebc938995", yahooSymbol: "SB=F", name: "Sugar" },
  { rootId: "cdd56574-85b6-4c42-aa76-2ab9eefd43a2", yahooSymbol: "CT=F", name: "Cotton" },
  // Live Cattle: was 17916524... (12 rows) -- corrected to c44804f1... (6,399 rows, latest 2026-09-11).
  { rootId: "c44804f1-19cd-44ee-aba5-f597bfbf3e04", yahooSymbol: "LE=F", name: "Live Cattle" },
  // Lean Hogs: was 35a2935b... (0 rows, confirmed empty) -- corrected to cba5f88f... (6,467 rows).
  { rootId: "cba5f88f-7051-4626-a2f0-8b7aa09f802a", yahooSymbol: "HE=F", name: "Lean Hogs" },
  // New (Task X10): Feeder Cattle is a distinct CME livestock contract from Live Cattle (different
  // underlying weight class), not a duplicate.
  { rootId: "50555c8c-e575-4a4f-a10d-b16ad76da848", yahooSymbol: "GF=F", name: "Feeder Cattle" },
  { rootId: "1614a922-96d0-42b5-a289-682bc344b1fa", yahooSymbol: "ZO=F", name: "Oats" },
  { rootId: "937b3fd5-cf31-4b30-a324-6fd7d33b430b", yahooSymbol: "OJ=F", name: "Orange Juice" },
  { rootId: "4b3fb696-c482-4ab1-ac1c-da7c2b15f2fb", yahooSymbol: "RB=F", name: "RBOB Gasoline" },
  { rootId: "2dcbe3e0-9440-401d-acd1-40ba9a4fc2d4", yahooSymbol: "ZR=F", name: "Rice" },
  { rootId: "4e6fe3d8-bdfd-4076-a0fe-7a19e1da9683", yahooSymbol: "HO=F", name: "Heating Oil (NY Harbor ULSD)" },
  // 2026-10-18 (user-approved write, verified before/after row count 890->891, exactly 1 row):
  // separate COMEX root for Yahoo's ALI=F, distinct from the pre-existing LME-listed aluminum root
  // (root_symbol "AH") -- see scripts/seed-comex-aluminum-root.ts for the full reasoning.
  { rootId: "e044c37c-a9cb-4ce1-bd57-0ea5492e2c3d", yahooSymbol: "ALI=F", name: "Aluminum (COMEX)" },
  // Still NOT added, by design:
  // - Dairy (Class III/IV Milk, Dry Whey, Nonfat Dry Milk, Cash-settled Butter/Cheese), Mont Belvieu
  //   TET Propane, Southern Yellow Pine Lumber: every futures_yahoo_symbol_mappings row found for
  //   these is a SPECIFIC delivery-month contract (e.g. "Class III Milk Futures,Apr-2027"), not a
  //   continuous `=F` ticker -- this pipeline's one-row-per-commodity model has no way to track
  //   contract expiry/rollover, so including a single expiring month would silently go stale. Needs
  //   a genuine continuous-contract Yahoo symbol (if one exists) before these can be added; flagged
  //   in docs/specs/technical-screener-reverse-lookup.md rather than forced in with a wrong model.
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
export async function updateCommodityHistory(
  cursor: string | null,
  batchSize = 3,
  roots?: typeof CORE_COMMODITY_ROOTS,
  writeEnabled = false,
): Promise<CommodityHistoryBatchResult> {
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
      // Reject non-finalized/placeholder bars, not just missing fields: a session still in
      // progress (or a not-yet-updated duplicate of the prior close) typically shows zero
      // aggregated volume or a flat high==low with no real trading range. Combined with each
      // caller only firing after that exchange group's real settlement (the route's `group`
      // param), this is the finalized-candle check — never a live/in-progress bar mistaken for
      // the official daily close.
      const candles = (chart?.candles ?? []).filter((c) =>
        c.close != null && c.close > 0 && c.high != null && c.low != null && c.open != null &&
        c.high !== c.low && !(c.volume != null && c.volume === 0)
      );
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
        // Task X9: shadow mode (writeEnabled=false, the default) fetches, parses and would-write
        // candles for diagnostics/spot-checking but performs NO database write at all -- this
        // pipeline originally had no such gate (see commodityWriteGate.ts for why one was added).
        if (writeEnabled) {
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
          // Task X9 review fix: only count a row as "written" when a write actually happened --
          // previously incremented unconditionally, so shadow-mode responses misleadingly reported
          // rowsWritten as if real writes occurred.
          wrote++;
        }
      }
      rowsWritten += wrote;
      updatedRoots++;
    } catch (error) {
      failedRoots.push({ rootId: root.rootId, symbol: root.yahooSymbol, reason: String(error) });
    }
  }

  return { requestedRoots: rows.length, updatedRoots, rowsWritten, failedRoots, lastId: wrapped ? null : rows.at(-1)!.rootId, wrapped };
}
