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
    // Newer-date-OR-same-date-different-value: Task Z fix — originally a stricter "newer date only"
    // rule than lib/yahoo/fundIngest.ts's own yahoo-fund-full-sweep write (which also updates when
    // the date matches but the nav value differs). That asymmetry meant a same-date disagreement
    // between the two pipelines' Yahoo sources (chart API vs Spark) could leave fund_history holding
    // one value while funds.latest_nav stayed at whichever pipeline wrote first — now aligned to the
    // same rule fundIngest.ts and lib/cloud-ingestion/fundNav.ts's persistFundNav both already use,
    // so all three pipelines agree on when funds.latest_nav may change. Still never moves the date
    // backward.
    await query(
      `UPDATE funds AS f SET
         latest_nav = x.nav, latest_nav_date = x.date::date, nav_updated_at = $2::timestamptz, last_nav_source = 'SPARK'
       FROM jsonb_to_recordset($1::jsonb) AS x(fund_id text, date text, nav numeric)
       WHERE f.id = x.fund_id AND (
         f.latest_nav_date IS NULL OR f.latest_nav_date < x.date::date
         OR (f.latest_nav_date = x.date::date AND f.latest_nav IS DISTINCT FROM x.nav)
       )`,
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
