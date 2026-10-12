// Funds whose Yahoo fundId returns genuinely empty data (not rate-limited, not a transient miss) get
// parked here instead of being re-fetched on every single tick forever. Re-checked after a 7-day
// cooldown in case Yahoo starts carrying the instrument again. Same existing
// production_scheduler_checkpoints table, its own key -- no new table.
export const KNOWN_NO_DATA_CHECKPOINT_KEY = "offshore-nav-sync:known-no-data";
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;
export type KnownNoDataMap = Map<string, string>; // fundId -> last-checked ISO timestamp

export async function loadKnownNoData(query: QueryFn): Promise<KnownNoDataMap> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [KNOWN_NO_DATA_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return new Map();
  try {
    const parsed: Record<string, string> = JSON.parse(raw);
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

export async function saveKnownNoData(query: QueryFn, map: KnownNoDataMap): Promise<void> {
  const payload = Object.fromEntries(map);
  await query(
    `INSERT INTO production_scheduler_checkpoints (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, 'OFFSHORE_NAV_SYNC', gen_random_uuid()::text, $2, $3, 0, 0, now(), now(), 'CRON')
     ON CONFLICT (checkpoint_key) DO UPDATE SET last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, updated_at = now()`,
    [KNOWN_NO_DATA_CHECKPOINT_KEY, JSON.stringify(payload), map.size],
  );
}

/** True if this fund was marked no-data within the last 7 days and should be skipped this tick. */
export function isOnCooldown(fundId: string, map: KnownNoDataMap, now = new Date()): boolean {
  const lastChecked = map.get(fundId);
  if (!lastChecked) return false;
  return now.getTime() - new Date(lastChecked).getTime() < COOLDOWN_MS;
}
