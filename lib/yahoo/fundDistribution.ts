// Fund distribution events at SHARE-CLASS level (fund_distribution_observations, existing table — no schema change).
//
// Rule: a distribution belongs to exactly one share class (its own Yahoo symbol → fund_provider_mappings →
// fund_id + share_class_id). Nothing is ever inherited from, or copied across, the master fund: sibling classes of one
// master pay different amounts. "No events" is NOT evidence of an accumulating class — it only means
// NO_DISTRIBUTION_HISTORY_AVAILABLE from this source, and nothing here labels a class accumulating/distributing.

import type { DividendEvent } from "./distributionFetch";

export type FundQuery = (sql: string, params: any[]) => Promise<any[]>;

export type FundDistributionBatch = {
  fundId: string;
  shareClassId: string;
  symbol: string;
  currency: string | null;
  events: DividendEvent[];
};

export const FUND_DISTRIBUTION_SOURCE = "YAHOO_CHART";

/**
 * Bulk write for a set of share classes (one call per sweep chunk):
 *  1) UPDATE rows whose amount was revised at the source (same fund + share class + ex-date + source),
 *  2) INSERT new events (never duplicating an existing fund/class/ex-date/source, whatever the amount).
 * The table's unique identity includes the amount, so revisions must be updated explicitly instead of via ON CONFLICT.
 */
export async function bulkUpsertFundDistributions(query: FundQuery, batches: FundDistributionBatch[], chunk = 1500) {
  const flat = batches.flatMap((b) =>
    b.events.map((e) => ({ f: b.fundId, s: b.shareClassId, d: e.exDate, a: String(e.amount), c: b.currency ?? "USD", r: `YAHOO:${b.symbol}:${e.exDate}` })),
  );
  let inserted = 0, updated = 0;
  for (let i = 0; i < flat.length; i += chunk) {
    const part = flat.slice(i, i + chunk);
    const arrays = [part.map((x) => x.f), part.map((x) => x.s), part.map((x) => x.d), part.map((x) => x.a), part.map((x) => x.c), part.map((x) => x.r)];
    const upd = await query(
      `UPDATE fund_distribution_observations o
          SET distribution_amount = t.amount::numeric, updated_at = NOW()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(fund_id, sc_id, ex_date, amount)
        WHERE o.fund_id = t.fund_id AND o.share_class_id = t.sc_id AND o.ex_date = t.ex_date::date AND o.source = '${FUND_DISTRIBUTION_SOURCE}'
          AND ABS(o.distribution_amount - t.amount::numeric) > 0.000001
        RETURNING 1`,
      arrays.slice(0, 4),
    );
    updated += upd.length;
    const ins = await query(
      `INSERT INTO fund_distribution_observations
         (id, fund_id, share_class_id, ex_date, distribution_amount, distribution_currency, source, source_record_id, created_at, updated_at)
       SELECT gen_random_uuid()::text, t.fund_id, t.sc_id, t.ex_date::date, t.amount::numeric, t.cur, '${FUND_DISTRIBUTION_SOURCE}', t.rid, NOW(), NOW()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(fund_id, sc_id, ex_date, amount, cur, rid)
        WHERE NOT EXISTS (
          SELECT 1 FROM fund_distribution_observations o
           WHERE o.fund_id = t.fund_id AND o.share_class_id = t.sc_id AND o.ex_date = t.ex_date::date AND o.source = '${FUND_DISTRIBUTION_SOURCE}')
       ON CONFLICT DO NOTHING
       RETURNING 1`,
      arrays,
    );
    inserted += ins.length;
  }
  return { inserted, updated };
}

/** Coverage summary for progress reporting (aggregate counts only — never per-symbol rows). */
export async function fundDistributionProgress(query: FundQuery) {
  const r = (
    await query(
      `SELECT (SELECT count(*)::int FROM fund_provider_mappings WHERE provider = 'YAHOO' AND share_class_id IS NOT NULL) AS total,
              (SELECT count(DISTINCT share_class_id)::int FROM fund_distribution_observations WHERE source = '${FUND_DISTRIBUTION_SOURCE}') AS with_history,
              (SELECT count(*)::int FROM fund_distribution_observations WHERE source = '${FUND_DISTRIBUTION_SOURCE}') AS events,
              (SELECT max(created_at) FROM fund_distribution_observations) AS last_write`,
      [],
    )
  )[0];
  return {
    TOTAL_SHARE_CLASSES: r.total,
    WITH_HISTORY: r.with_history,
    EMPTY_OR_NO_EVENTS_OR_UNCHECKED: Math.max(0, r.total - r.with_history), // NO_EVENTS is not "accumulating"
    EVENT_COUNT: r.events,
    LAST_EVENT_WRITE: r.last_write,
  };
}
