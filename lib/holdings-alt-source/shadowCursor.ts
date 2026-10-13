// Shadow-mode-only rotation cursor. Problem this solves: selection.ts picks oldest-fetched-or-never
// first based on REAL rows in `holdings` -- correct for write mode, but shadow mode never writes a row
// (writer.ts returns written=0 when the gate is off), so every shadow run would see the exact same
// "never fetched" 33 funds at the front of the list forever, and shadow verification would never cover
// more than that first batch.
//
// This cursor tracks which fundIds have been VISITED by a shadow run in the current rotation cycle
// (independent of whether the fetch succeeded -- a fund that was attempted and failed still shouldn't
// block coverage of the rest of the universe). It has NO effect on write-mode selection, which keeps
// using selectOldestFirst's DB-truth freshness check exactly as before -- this file is only ever
// consulted when currentRunMode() === "SHADOW".
export const SHADOW_CURSOR_CHECKPOINT_KEY = "holdings-alt-source-sync:shadow-cursor";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

type ShadowCursorState = { processedFundIds: string[]; cycleStartedAt: string };

export async function loadShadowCursor(query: QueryFn): Promise<ShadowCursorState> {
  const rows = await query(
    `SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`,
    [SHADOW_CURSOR_CHECKPOINT_KEY],
  );
  const raw = rows[0]?.last_symbol;
  if (!raw) return { processedFundIds: [], cycleStartedAt: new Date().toISOString() };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.processedFundIds)) return parsed as ShadowCursorState;
  } catch {
    // fall through to a fresh cycle
  }
  return { processedFundIds: [], cycleStartedAt: new Date().toISOString() };
}

export async function saveShadowCursor(query: QueryFn, runId: string, state: ShadowCursorState): Promise<void> {
  const payload = JSON.stringify(state);
  await query(
    `INSERT INTO production_scheduler_checkpoints
       (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, 'HOLDINGS_ALT_SOURCE_SYNC', $2, $3, $4, $4, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ROLLING')
     ON CONFLICT (checkpoint_key) DO UPDATE
       SET run_id = EXCLUDED.run_id, last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed,
           succeeded = EXCLUDED.succeeded, updated_at = CURRENT_TIMESTAMP`,
    [SHADOW_CURSOR_CHECKPOINT_KEY, runId, payload, state.processedFundIds.length],
  );
}

/** Picks the next batch for a SHADOW run: funds not yet visited in the current rotation cycle, in a
 * stable order (sorted by fundId, independent of `holdings` table state). If every fund in the universe
 * has already been visited this cycle, resets and starts a fresh cycle from the top (1-3). Does NOT
 * mutate the checkpoint itself -- the caller must call saveShadowCursor with the updated set after the
 * run actually processes its batch, so a run that crashes before finishing doesn't lose nothing (same
 * "only count what really happened" principle as the run's own attempted/fetched counters). */
export function selectShadowBatch<T extends { fundId: string }>(
  universe: T[],
  cursorState: ShadowCursorState,
): { batch: T[]; startingState: ShadowCursorState; cycleWillReset: boolean } {
  const stableUniverse = [...universe].sort((a, b) => a.fundId.localeCompare(b.fundId));
  const processedSet = new Set(cursorState.processedFundIds);
  let remaining = stableUniverse.filter((u) => !processedSet.has(u.fundId));
  let cycleWillReset = false;
  let startingState = cursorState;

  if (remaining.length === 0 && stableUniverse.length > 0) {
    cycleWillReset = true;
    startingState = { processedFundIds: [], cycleStartedAt: new Date().toISOString() };
    remaining = stableUniverse;
  }

  return { batch: remaining, startingState, cycleWillReset };
}
