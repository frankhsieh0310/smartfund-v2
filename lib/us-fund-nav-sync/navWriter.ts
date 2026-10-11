// Task Y: the ONLY place in this feature that writes fund_history/funds.latest_nav* — never called
// unless writeGate.isWriteEnabled() is true (FUND_NAV_SYNC_WRITE, off by default this round).
// fund_history upsert mirrors the existing lib/cloud-ingestion/fundNav.ts SITCA path's own shape
// (same table, same (fund_id, date) conflict key); the funds.latest_nav* "newer date only" guard
// mirrors that file's persistFundNav exactly, so this pipeline and the existing SITCA/Yahoo-sweep
// pipeline can never clobber each other's more-recent NAV with a stale one.
import type { FundNavCandidate } from "./types";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type WriteBatchResult = {
  written: number;
  writeErrorCount: number; // funds whose write threw and were skipped entirely — retried next run via the DB-truth completion check
  writeErrorFundIds: string[];
};

export async function writeFundNavBatch(query: QueryFn, candidates: FundNavCandidate[], nowIso: string): Promise<WriteBatchResult> {
  if (candidates.length === 0) return { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };

  const payload = candidates.map((c) => ({ fund_id: c.fundId, date: c.date, nav: c.nav }));

  try {
    await query(
      `INSERT INTO fund_history (id, fund_id, date, nav, created_at)
       SELECT gen_random_uuid()::text, x.fund_id, x.date::date, x.nav, $2::timestamptz
         FROM jsonb_to_recordset($1::jsonb) AS x(fund_id text, date text, nav numeric)
       ON CONFLICT (fund_id, date) DO UPDATE SET nav = EXCLUDED.nav
       WHERE fund_history.nav IS DISTINCT FROM EXCLUDED.nav`,
      [JSON.stringify(payload), nowIso],
    );
    // Newer-date-only: same rule lib/cloud-ingestion/fundNav.ts's persistFundNav already uses for
    // SITCA, applied here for Spark too — a same-or-older date from this pipeline can never move
    // funds.latest_nav backward or clobber a value another pipeline already advanced past it.
    await query(
      `UPDATE funds AS f SET
         latest_nav = x.nav, latest_nav_date = x.date::date, nav_updated_at = $2::timestamptz, last_nav_source = 'SPARK'
       FROM jsonb_to_recordset($1::jsonb) AS x(fund_id text, date text, nav numeric)
       WHERE f.id = x.fund_id AND (f.latest_nav_date IS NULL OR f.latest_nav_date < x.date::date)`,
      [JSON.stringify(payload), nowIso],
    );
    return { written: candidates.length, writeErrorCount: 0, writeErrorFundIds: [] };
  } catch {
    return { written: 0, writeErrorCount: candidates.length, writeErrorFundIds: candidates.map((c) => c.fundId) };
  }
}

export async function writeBatchIfEnabled(query: QueryFn, candidates: FundNavCandidate[], nowIso: string, writeEnabled: boolean): Promise<WriteBatchResult> {
  if (!writeEnabled) return { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };
  return writeFundNavBatch(query, candidates, nowIso);
}
