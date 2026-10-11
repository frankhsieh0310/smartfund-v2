// Task Z: writes fund_history + funds.latest_nav* for SITCA-matched candidates — same upsert shape
// as lib/us-fund-nav-sync/navWriter.ts and lib/cloud-ingestion/fundNav.ts's own persistFundNav
// (newer-date-OR-same-date-different-value, never backward), so all three domestic/US fund NAV
// writers agree on when funds.latest_nav may change. Never called unless writeGate.isWriteEnabled()
// is true (SITCA_NAV_SYNC_WRITE, off by default this round).
import type { SitcaMatchedCandidate } from "./types";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type WriteBatchResult = {
  written: number;
  writeErrorCount: number;
  writeErrorFundIds: string[];
};

const CHUNK_SIZE = 500;

export async function writeSitcaNavBatch(query: QueryFn, candidates: SitcaMatchedCandidate[], nowIso: string): Promise<WriteBatchResult> {
  if (candidates.length === 0) return { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };

  let written = 0;
  let writeErrorCount = 0;
  const writeErrorFundIds: string[] = [];

  // Chunked, each chunk isolated in its own try/catch — one bad chunk never blocks the rest.
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
      await query(
        `UPDATE funds AS f SET
           latest_nav = x.nav, latest_nav_date = x.date::date, nav_updated_at = $2::timestamptz, last_nav_source = 'SITCA_FSC_OFFICIAL_DAILY_NAV_CSV'
         FROM jsonb_to_recordset($1::jsonb) AS x(fund_id text, date text, nav numeric)
         WHERE f.id = x.fund_id AND (
           f.latest_nav_date IS NULL OR f.latest_nav_date < x.date::date
           OR (f.latest_nav_date = x.date::date AND f.latest_nav IS DISTINCT FROM x.nav)
         )`,
        [JSON.stringify(payload), nowIso],
      );
      written += chunk.length;
    } catch {
      writeErrorCount += chunk.length;
      writeErrorFundIds.push(...chunk.map((c) => c.fundId));
    }
  }

  return { written, writeErrorCount, writeErrorFundIds };
}

export async function writeBatchIfEnabled(query: QueryFn, candidates: SitcaMatchedCandidate[], nowIso: string, writeEnabled: boolean): Promise<WriteBatchResult> {
  if (!writeEnabled) return { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };
  return writeSitcaNavBatch(query, candidates, nowIso);
}
