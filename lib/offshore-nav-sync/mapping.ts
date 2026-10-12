// The DB-code -> Yahoo fundId mapping (962-fund tdcc-offshore sweep, Task Z/R item 2) is pre-computed
// and seeded once into the existing production_scheduler_checkpoints table (checkpoint_key below) --
// never rebuilt live by this route, so each recurring invocation spends its whole per-fund request
// budget on the actual NAV fetch (fundsPriceHistory), never on re-searching Yahoo for a fundId.
export const MAPPING_CHECKPOINT_KEY = "offshore-nav-sync:yahoo-mapping";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export async function loadMapping(query: QueryFn): Promise<import("./types").OffshoreMappingEntry[]> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [MAPPING_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
