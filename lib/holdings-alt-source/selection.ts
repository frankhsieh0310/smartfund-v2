// Oldest/never-fetched-first selection, based on ACTUAL DB rows in `holdings` for this source --
// never on a shadow-mode-only signal, same "only a real write counts as attempted" principle already
// established for domestic-dividend-sync/offshore-dividend-sync this session. Shadow-mode runs never
// write a row (writer.ts returns written=0 when the gate is off), so a fund can never look "already
// fetched" from a shadow run alone -- the freshness check is naturally gated by that, with no separate
// flag needed.
export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type MappingEntry = { fundId: string; code: string; yahooFundId: string };
export type SortedMappingEntry = MappingEntry & { lastFetchedDate: string | null };

export async function selectOldestFirst(
  query: QueryFn,
  mapping: MappingEntry[],
  source: string,
  freshDays: number,
): Promise<SortedMappingEntry[]> {
  if (mapping.length === 0) return [];
  const fundIds = mapping.map((m) => m.fundId);
  const rows = await query(
    `SELECT fund_id, MAX(as_of_date)::text AS last_date FROM holdings WHERE fund_id = ANY($1::text[]) AND source = $2 GROUP BY fund_id`,
    [fundIds, source],
  );
  const lastDateByFund = new Map<string, string>(rows.map((r) => [r.fund_id, r.last_date]));
  const freshMs = freshDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const withDate: SortedMappingEntry[] = mapping.map((m) => ({ ...m, lastFetchedDate: lastDateByFund.get(m.fundId) ?? null }));
  const eligible = withDate.filter((m) => !m.lastFetchedDate || now - new Date(m.lastFetchedDate).getTime() > freshMs);

  eligible.sort((a, b) => {
    if (!a.lastFetchedDate && !b.lastFetchedDate) return 0;
    if (!a.lastFetchedDate) return -1; // never-fetched sorts first
    if (!b.lastFetchedDate) return 1;
    return new Date(a.lastFetchedDate).getTime() - new Date(b.lastFetchedDate).getTime(); // oldest first
  });

  return eligible;
}
