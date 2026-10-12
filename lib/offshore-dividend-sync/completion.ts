// Day-scoped "already attempted today" tracking, mirroring offshore-nav-sync's (already-fixed)
// pattern: only a write-enabled attempt consumes today's slot, so a shadow-mode run never blocks a
// later write-mode run from re-attempting the same fund.
export const PROGRESS_CHECKPOINT_KEY = "offshore-dividend-sync:daily-progress";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;
export type DailyProgress = { date: string; attemptedFundIds: string[] };

export async function loadDailyProgress(query: QueryFn, today: string): Promise<Set<string>> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [PROGRESS_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return new Set();
  try {
    const parsed: DailyProgress = JSON.parse(raw);
    if (parsed.date !== today) return new Set();
    return new Set(parsed.attemptedFundIds ?? []);
  } catch {
    return new Set();
  }
}

export async function saveDailyProgress(query: QueryFn, today: string, attemptedFundIds: Set<string>): Promise<void> {
  const payload: DailyProgress = { date: today, attemptedFundIds: [...attemptedFundIds] };
  await query(
    `INSERT INTO production_scheduler_checkpoints (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, 'OFFSHORE_DIVIDEND_SYNC', gen_random_uuid()::text, $2, $3, 0, 0, now(), now(), 'CRON')
     ON CONFLICT (checkpoint_key) DO UPDATE SET last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, updated_at = now()`,
    [PROGRESS_CHECKPOINT_KEY, JSON.stringify(payload), attemptedFundIds.size],
  );
}
