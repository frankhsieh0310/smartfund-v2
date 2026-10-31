// The DB-code -> Yahoo fundId mapping (962-fund tdcc-offshore sweep, Task Z/R item 2) is pre-computed
// and seeded once into the existing production_scheduler_checkpoints table (checkpoint_key below) --
// never rebuilt live by this route, so each recurring invocation spends its whole per-fund request
// budget on the actual NAV fetch (fundsPriceHistory), never on re-searching Yahoo for a fundId.
export const MAPPING_CHECKPOINT_KEY = "offshore-nav-sync:yahoo-mapping";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

// 2026-10-31（使用者核准，商品範圍最高原則）: VERIFIED這個靜態checkpoint裡0.8%(9/1195)已經不是
// APPROVED（一次性sweep/discovery建立後，分類狀態變動不會自動反映回checkpoint）。這裡是唯一的
// loader，offshore-nav-sync跟holdings-alt-source-sync兩個呼叫端都共用，在這裡統一過濾一次，
// 不用每個呼叫端各自重複同一段SQL，也不會漏掉任何一個呼叫端。
export async function loadMapping(query: QueryFn): Promise<import("./types").OffshoreMappingEntry[]> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [MAPPING_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return [];
  let parsed: import("./types").OffshoreMappingEntry[];
  try {
    const arr = JSON.parse(raw);
    parsed = Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
  if (parsed.length === 0) return [];
  const approvedRows = await query(
    `SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED' AND asset_id = ANY($1::text[])`,
    [parsed.map((m) => m.fundId)],
  );
  const approvedSet = new Set(approvedRows.map((r: any) => r.asset_id));
  return parsed.filter((m) => approvedSet.has(m.fundId));
}
