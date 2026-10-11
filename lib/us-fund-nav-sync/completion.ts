// DB-truth completion: a fund counts as "done for `date`" only if fund_history already has a row
// for it on that exact date — batched (one query for however many ids are passed), same lesson Task
// X6 learned the hard way for etf-returns-sync's own per-item version of this check.
export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export async function lookupDoneFundIds(query: QueryFn, fundIds: string[], date: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (fundIds.length === 0) return done;
  const BATCH = 1000;
  for (let i = 0; i < fundIds.length; i += BATCH) {
    const batch = fundIds.slice(i, i + BATCH);
    const rows = await query(`SELECT fund_id FROM fund_history WHERE fund_id = ANY($1::text[]) AND date = $2::date`, [batch, date]);
    for (const r of rows) done.add(r.fund_id);
  }
  return done;
}
