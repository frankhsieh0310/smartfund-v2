// Rotation-cursor progress tracking, replacing the old calendar-day-scoped checkpoint.
//
// 2026-10-13 fix: the old version reset `attemptedFundIds` to empty whenever the stored checkpoint's
// `date` didn't match today (UTC calendar day) -- see git history. Confirmed live via
// production_scheduler_runs: at ~61 funds/run and 12 scheduled runs/day (13:00-15:45 Taipei), only
// ~733/962 funds get attempted before the day's last run, so ~229-240 funds are structurally never
// reached THAT DAY. Because the underlying `SELECT ... FROM funds` has no ORDER BY but returns a
// confirmed-stable row order run-to-run (verified empirically, 3 repeat queries, byte-identical order),
// the SAME leading ~730 funds (by that incidental physical order) get priority every single day, and the
// day-scoped reset means the trailing funds' progress from yesterday counts for nothing today -- there
// is no guarantee the tail ever catches up, only however this day's run timing happens to land.
//
// Fix: track progress as a ROTATING CURSOR (processedFundIds) that is NOT tied to calendar date and is
// never reset except when the full universe has actually been covered (cycleWillReset). This is the
// same rotation algorithm already proven in lib/holdings-alt-source/shadowCursor.ts for the identical
// "don't let an unordered/incomplete-per-invocation list permanently starve a tail" problem, applied
// here to write-mode instead of shadow-mode. A full rotation (962 funds at ~61/run, 12 runs/day) now
// takes about 1.3 days; each fund is guaranteed to be reached at least once per completed cycle,
// regardless of where it falls in the underlying table's incidental row order.
export const PROGRESS_CHECKPOINT_KEY = "offshore-dividend-sync:rotation-progress";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;
export type RotationProgress = { processedFundIds: string[] };

export async function loadRotationProgress(query: QueryFn): Promise<Set<string>> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [PROGRESS_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return new Set();
  try {
    const parsed: RotationProgress = JSON.parse(raw);
    return new Set(parsed.processedFundIds ?? []);
  } catch {
    return new Set();
  }
}

export async function saveRotationProgress(query: QueryFn, runId: string, processedFundIds: Set<string>): Promise<void> {
  const payload: RotationProgress = { processedFundIds: [...processedFundIds] };
  await query(
    `INSERT INTO production_scheduler_checkpoints
       (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, 'OFFSHORE_DIVIDEND_SYNC', $2, $3, $4, 0, 0, now(), now(), 'ROLLING')
     ON CONFLICT (checkpoint_key) DO UPDATE
       SET run_id = EXCLUDED.run_id, last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, updated_at = now()`,
    [PROGRESS_CHECKPOINT_KEY, runId, JSON.stringify(payload), processedFundIds.size],
  );
}

/** Picks the next batch to attempt: funds not yet processed in the current rotation cycle, in a stable
 * order (sorted by id) so rotation is deterministic regardless of the underlying table's incidental row
 * order. If every fund has already been processed this cycle, resets and starts a fresh cycle from the
 * top (so coverage is never permanently blocked on any subset). */
export function selectRotationBatch<T extends { id: string }>(
  universe: T[],
  processedFundIds: Set<string>,
): { pending: T[]; cycleWillReset: boolean; startingProcessed: Set<string> } {
  const stableUniverse = [...universe].sort((a, b) => a.id.localeCompare(b.id));
  let pending = stableUniverse.filter((u) => !processedFundIds.has(u.id));
  let cycleWillReset = false;
  let startingProcessed = processedFundIds;

  if (pending.length === 0 && stableUniverse.length > 0) {
    cycleWillReset = true;
    startingProcessed = new Set();
    pending = stableUniverse;
  }

  return { pending, cycleWillReset, startingProcessed };
}
