// DB-truth completion: a month is "done" once it's in this checkpoint's completedMonths list. First
// run has an empty list, so it naturally backfills every month SITCA's own dropdown offers (2022/06
// onward) before settling into "only the newest month is ever missing" steady state. Same
// write-mode-gated convention as offshore-nav-sync/offshore-dividend-sync: a shadow-mode run never
// marks a month complete, so it can't block a later write-mode run from actually persisting it.
export const PROGRESS_CHECKPOINT_KEY = "domestic-dividend-sync:completed-months";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;
export type Progress = { completedMonths: string[] };

export async function loadCompletedMonths(query: QueryFn): Promise<Set<string>> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [PROGRESS_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return new Set();
  try {
    const parsed: Progress = JSON.parse(raw);
    return new Set(parsed.completedMonths ?? []);
  } catch {
    return new Set();
  }
}

export async function saveCompletedMonths(query: QueryFn, completedMonths: Set<string>): Promise<void> {
  const payload: Progress = { completedMonths: [...completedMonths].sort() };
  await query(
    `INSERT INTO production_scheduler_checkpoints (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, 'DOMESTIC_DIVIDEND_SYNC', gen_random_uuid()::text, $2, $3, 0, 0, now(), now(), 'CRON')
     ON CONFLICT (checkpoint_key) DO UPDATE SET last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, updated_at = now()`,
    [PROGRESS_CHECKPOINT_KEY, JSON.stringify(payload), completedMonths.size],
  );
}
