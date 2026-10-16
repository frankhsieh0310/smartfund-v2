// Strictly forward-only date rule (user-specified for this pipeline: "日期只能前進") -- unlike
// sitca-nav-sync/us-fund-nav-sync's shared same-date-different-value rule, this one ONLY ever advances
// latest_nav_date, never touches an existing date. Chunked, per-chunk error isolation.
import type { OffshoreNavCandidate } from "./types";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type WriteBatchResult = {
  written: number;
  writeErrorCount: number;
  writeErrorFundIds: string[];
};

const CHUNK_SIZE = 200;

export async function writeOffshoreNavBatch(query: QueryFn, candidates: OffshoreNavCandidate[], nowIso: string): Promise<WriteBatchResult> {
  if (candidates.length === 0) return { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };

  let written = 0;
  let writeErrorCount = 0;
  const writeErrorFundIds: string[] = [];

  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    const payload = chunk.map((c) => ({ fund_id: c.fundId, date: c.navDate, nav: c.nav }));
    try {
      await query(
        `INSERT INTO fund_history (id, fund_id, date, nav, created_at)
         SELECT gen_random_uuid()::text, x.fund_id, x.date::date, x.nav, $2::timestamptz
           FROM jsonb_to_recordset($1::jsonb) AS x(fund_id text, date text, nav numeric)
         ON CONFLICT (fund_id, date) DO UPDATE SET nav = EXCLUDED.nav
         WHERE fund_history.nav IS DISTINCT FROM EXCLUDED.nav`,
        [JSON.stringify(payload), nowIso],
      );
      const updated = await query(
        `UPDATE funds AS f SET
           latest_nav = x.nav, latest_nav_date = x.date::date, nav_updated_at = $2::timestamptz, last_nav_source = 'YAHOO_FUND_PRICE_HISTORY'
         FROM jsonb_to_recordset($1::jsonb) AS x(fund_id text, date text, nav numeric)
         WHERE f.id = x.fund_id AND (f.latest_nav_date IS NULL OR f.latest_nav_date < x.date::date)
         RETURNING f.id`,
        [JSON.stringify(payload), nowIso],
      );
      // Count the UPDATE's real affected-row count, not the chunk size -- a chunk can run with zero
      // exceptions while the forward-only-date WHERE clause matches none of its rows (e.g. every
      // candidate was already written by an earlier run), and `written` must reflect that honestly.
      written += updated.length;
    } catch {
      writeErrorCount += chunk.length;
      writeErrorFundIds.push(...chunk.map((c) => c.fundId));
    }
  }

  return { written, writeErrorCount, writeErrorFundIds };
}

export async function writeBatchIfEnabled(query: QueryFn, candidates: OffshoreNavCandidate[], nowIso: string, writeEnabled: boolean): Promise<WriteBatchResult> {
  if (!writeEnabled) return { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };
  return writeOffshoreNavBatch(query, candidates, nowIso);
}

/** Same forward-only-date / fund_history + funds.latest_nav* writer as writeOffshoreNavBatch, but
 * tagged with a distinct last_nav_source so rows written from TDCC's own official batch NAV CSV
 * (lib/offshore-nav-sync/tdccBatchSource.ts) are never confused with the per-fund Yahoo奇摩 scrape
 * this pipeline otherwise uses. */
export async function writeTdccNavBatch(query: QueryFn, candidates: OffshoreNavCandidate[], nowIso: string): Promise<WriteBatchResult> {
  if (candidates.length === 0) return { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };

  let written = 0;
  let writeErrorCount = 0;
  const writeErrorFundIds: string[] = [];

  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    const payload = chunk.map((c) => ({ fund_id: c.fundId, date: c.navDate, nav: c.nav }));
    try {
      await query(
        `INSERT INTO fund_history (id, fund_id, date, nav, created_at)
         SELECT gen_random_uuid()::text, x.fund_id, x.date::date, x.nav, $2::timestamptz
           FROM jsonb_to_recordset($1::jsonb) AS x(fund_id text, date text, nav numeric)
         ON CONFLICT (fund_id, date) DO UPDATE SET nav = EXCLUDED.nav
         WHERE fund_history.nav IS DISTINCT FROM EXCLUDED.nav`,
        [JSON.stringify(payload), nowIso],
      );
      const updated = await query(
        `UPDATE funds AS f SET
           latest_nav = x.nav, latest_nav_date = x.date::date, nav_updated_at = $2::timestamptz, last_nav_source = 'TDCC_OPENDATA_NAV'
         FROM jsonb_to_recordset($1::jsonb) AS x(fund_id text, date text, nav numeric)
         WHERE f.id = x.fund_id AND (f.latest_nav_date IS NULL OR f.latest_nav_date < x.date::date)
         RETURNING f.id`,
        [JSON.stringify(payload), nowIso],
      );
      written += updated.length;
    } catch {
      writeErrorCount += chunk.length;
      writeErrorFundIds.push(...chunk.map((c) => c.fundId));
    }
  }

  return { written, writeErrorCount, writeErrorFundIds };
}
