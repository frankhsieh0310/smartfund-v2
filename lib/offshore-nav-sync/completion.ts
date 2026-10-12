// Day-scoped "already attempted today" tracking, stored in the SAME existing
// production_scheduler_checkpoints table under its own key (never a new table) -- mirrors
// etf-returns-sync's lastProcessedDate pattern: each fund gets exactly one attempt per calendar day,
// spread across the day's several scheduled ticks, DB-truth-driven (a fund whose funds.latest_nav_date
// is already today's target is naturally a no-op write anyway; this tracking only avoids re-hitting
// Yahoo for a fund already attempted today within this same run-day, success or not).
export const PROGRESS_CHECKPOINT_KEY = "offshore-nav-sync:daily-progress";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;
export type DailyProgress = { date: string; attemptedFundIds: string[] };

export async function loadDailyProgress(query: QueryFn, today: string): Promise<Set<string>> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [PROGRESS_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return new Set();
  try {
    const parsed: DailyProgress = JSON.parse(raw);
    if (parsed.date !== today) return new Set(); // new day, start fresh
    return new Set(parsed.attemptedFundIds ?? []);
  } catch {
    return new Set();
  }
}

export async function saveDailyProgress(query: QueryFn, today: string, attemptedFundIds: Set<string>): Promise<void> {
  const payload: DailyProgress = { date: today, attemptedFundIds: [...attemptedFundIds] };
  await query(
    `INSERT INTO production_scheduler_checkpoints (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, 'OFFSHORE_NAV_SYNC', gen_random_uuid()::text, $2, $3, 0, 0, now(), now(), 'CRON')
     ON CONFLICT (checkpoint_key) DO UPDATE SET last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, updated_at = now()`,
    [PROGRESS_CHECKPOINT_KEY, JSON.stringify(payload), attemptedFundIds.size],
  );
}
