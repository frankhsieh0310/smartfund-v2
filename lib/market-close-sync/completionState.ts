// Per-market completion state machine for one target trading date. Decides whether a market has
// truly finished syncing (every candidate ETF has reached a FINAL classification) or still has
// unresolved work — pending confirmations, a NO_BAR cooling-off window, or a batch that never
// actually got fetched.
//
// Task K root cause: the pre-existing route.ts marked a market "done" the moment its forward cursor
// ran out of candidate rows to query — a single pass, regardless of how many of those candidates
// ended up SOURCE_MISSING or NO_BAR_FOR_TARGET_DATE on that one pass. Task I's real run did exactly
// this and wrongly stamped TWSE/Japan/HK as ALREADY_DONE after one look, before any of Task J's
// classification fixes even existed to tell SOURCE_MISSING apart from a transient same-day
// publication lag. This module makes "done" a real, confirmed state:
//
//   FINAL (trusted the first time they're observed): NEW, CHANGED, SAME, DB_NEWER, (Task N)
//   NO_TRADE_ON_TARGET — once "now" is past the target date's own close+delay and the live quote's
//   own date is confirmed EARLIER than the target date, there is nothing left to wait for: the
//   market simply didn't trade that day, and no later re-check can change that fact — and (Task O)
//   UNIT_MISMATCH/PRICE_JUMP_REVIEW, both record-only review buckets for a price that already
//   resolved but failed the sanity check against the ETF's own last known DB close; re-checking
//   later wouldn't un-flag a one-day data anomaly, so these are final the first time too.
//   PROVISIONAL (need a second look before they count as done):
//     - SOURCE_MISSING: must be re-observed as SOURCE_MISSING on a SEPARATE later pass before it's
//       trusted — a single observation only starts the pending clock.
//     - NO_BAR_FOR_TARGET_DATE: only trusted once re-observed at least NO_BAR_CONFIRM_DELAY_MS after
//       the FIRST time it was seen missing (not "since market close" — the pending entry's own
//       firstSeenAtMs is the anchor, which is always at-or-after close since classify() is never
//       reached for a market that isn't already eligible/closed).
//   NOT A CLASSIFICATION AT ALL: a batch fetch failure (network/timeout/rate-limit/non-200). classify()
//   is never called for those candidates — advanceSweep(state, { ok: false }) is a strict no-op, so a
//   fetch failure can never advance sweepComplete or resolve/add a pending entry.

export type PendingState = "SOURCE_MISSING_PENDING" | "NO_BAR_PENDING";

export type PendingEntry = { etfId: string; symbol: string; state: PendingState; firstSeenAtMs: number };

export type FinalOrPendingClassification = "NEW" | "CHANGED" | "SAME" | "DB_NEWER" | "SOURCE_MISSING" | "NO_BAR_FOR_TARGET_DATE" | "NO_TRADE_ON_TARGET" | "UNIT_MISMATCH" | "PRICE_JUMP_REVIEW" | "DB_DISCONTINUITY";

export const NO_BAR_CONFIRM_DELAY_MS = 6 * 60 * 60 * 1000;

// Task W4: classifications that will NEVER produce an etf_history row for targetLocalDate, in
// EITHER run mode — SOURCE_MISSING (no price found anywhere), NO_TRADE_ON_TARGET (the market simply
// didn't trade that day), UNIT_MISMATCH/PRICE_JUMP_REVIEW (sanity-rejected, record-only). A plain
// "does the DB have a row for this date" check can never see these as resolved, so their ETF ids are
// tracked separately and must be treated as satisfying "done" alongside an actual DB row. NEW,
// CHANGED, SAME, DB_NEWER and DB_DISCONTINUITY are deliberately excluded: each of those either
// already corresponds to an existing DB row (SAME/DB_NEWER) or is EXPECTED to produce one once write
// mode actually writes it (NEW/CHANGED/DB_DISCONTINUITY) — if write mode never writes it (shadow
// mode, by design, never does), the DB-gap check must keep seeing it as missing, not "done".
const TERMINAL_NON_WRITE_CLASSIFICATIONS = new Set<FinalOrPendingClassification>([
  "SOURCE_MISSING", "NO_TRADE_ON_TARGET", "UNIT_MISMATCH", "PRICE_JUMP_REVIEW",
]);

export type MarketCompletionState = {
  targetLocalDate: string;
  cursorEtfId: string; // forward sweep cursor; meaningless once sweepComplete is true
  sweepComplete: boolean; // true once the forward cursor scan has reached the end of the candidate universe at least once
  pending: PendingEntry[];
  // Task W4: etfId -> the terminal-non-write classification it was CONFIRMED as (SOURCE_MISSING only
  // added here once past its 2-observation confirmation, same as applyObservation's own pending ->
  // final transition). Accumulates across the whole sweep for targetLocalDate; never cleared until a
  // new targetLocalDate's state is started. Used by the DB-gap check (route.ts) to recognize an ETF
  // as done even though it will never get an etf_history row for this date.
  terminalNonWrite: Record<string, FinalOrPendingClassification>;
};

export function emptyState(targetLocalDate: string): MarketCompletionState {
  return { targetLocalDate, cursorEtfId: "", sweepComplete: false, pending: [], terminalNonWrite: {} };
}

/** Pure: which of `coreUniverseEtfIds` are still missing real data for targetLocalDate — present
 * neither as a DB row (`dbPresentIds`, from an actual etf_history query) nor as a confirmed
 * terminal-non-write classification. This is the single source of truth Task W4 requires: checkpoint
 * state (sweepComplete, lastDoneDate) may use this as a fast-path hint, but must never substitute for
 * it — a market is only truly done for a date once this returns an empty array. */
export function computeDbGapIds(
  coreUniverseEtfIds: string[],
  dbPresentIds: ReadonlySet<string>,
  terminalNonWrite: Record<string, FinalOrPendingClassification>,
): string[] {
  return coreUniverseEtfIds.filter((id) => !dbPresentIds.has(id) && terminalNonWrite[id] === undefined);
}

function applyObservation(
  pending: PendingEntry[],
  terminalNonWrite: Record<string, FinalOrPendingClassification>,
  etfId: string,
  symbol: string,
  classification: FinalOrPendingClassification,
  nowMs: number,
): { pending: PendingEntry[]; terminalNonWrite: Record<string, FinalOrPendingClassification> } {
  const existing = pending.find((p) => p.etfId === etfId);
  const withoutExisting = pending.filter((p) => p.etfId !== etfId);

  if (classification === "NEW" || classification === "CHANGED" || classification === "SAME" || classification === "DB_NEWER" || classification === "DB_DISCONTINUITY") {
    return { pending: withoutExisting, terminalNonWrite }; // final the first time; expected to correspond to a DB row
  }

  if (TERMINAL_NON_WRITE_CLASSIFICATIONS.has(classification) && classification !== "SOURCE_MISSING") {
    return { pending: withoutExisting, terminalNonWrite: { ...terminalNonWrite, [etfId]: classification } };
  }

  if (classification === "SOURCE_MISSING") {
    if (existing?.state === "SOURCE_MISSING_PENDING") {
      return { pending: withoutExisting, terminalNonWrite: { ...terminalNonWrite, [etfId]: classification } }; // second confirmation -> final
    }
    return { pending: [...withoutExisting, { etfId, symbol, state: "SOURCE_MISSING_PENDING", firstSeenAtMs: nowMs }], terminalNonWrite };
  }

  // NO_BAR_FOR_TARGET_DATE
  if (existing?.state === "NO_BAR_PENDING" && nowMs - existing.firstSeenAtMs >= NO_BAR_CONFIRM_DELAY_MS) {
    return { pending: withoutExisting, terminalNonWrite }; // re-observed past the cooling-off window -> final (not terminal-non-write: a bar may still arrive)
  }
  // Keep (or start) the pending entry, preserving the ORIGINAL firstSeenAtMs so the 6h window is
  // measured from when this ETF was first seen without a bar, never reset by a later re-check.
  const firstSeenAtMs = existing?.state === "NO_BAR_PENDING" ? existing.firstSeenAtMs : nowMs;
  return { pending: [...withoutExisting, { etfId, symbol, state: "NO_BAR_PENDING", firstSeenAtMs }], terminalNonWrite };
}

export type BatchOutcome =
  | { ok: true; isLastBatch: boolean; observations: Array<{ etfId: string; symbol: string; classification: FinalOrPendingClassification }> }
  | { ok: false }; // the batch never actually got fetched — route.ts retries the same cursor position next invocation

/** Advances the sweep by one batch's outcome. A failed fetch (`ok: false`) is a strict no-op: no
 * observation is applied, sweepComplete is untouched, cursorEtfId is untouched — the exact same
 * state is returned, so this batch's candidates remain unclassified and un-final until a future
 * invocation successfully re-fetches them. */
export function advanceSweep(state: MarketCompletionState, outcome: BatchOutcome, nowMs: number, newCursorEtfId?: string): MarketCompletionState {
  if (!outcome.ok) return state;
  let pending = state.pending;
  let terminalNonWrite = state.terminalNonWrite;
  for (const obs of outcome.observations) {
    const applied = applyObservation(pending, terminalNonWrite, obs.etfId, obs.symbol, obs.classification, nowMs);
    pending = applied.pending;
    terminalNonWrite = applied.terminalNonWrite;
  }
  return {
    ...state,
    pending,
    terminalNonWrite,
    sweepComplete: state.sweepComplete || outcome.isLastBatch,
    cursorEtfId: outcome.isLastBatch ? state.cursorEtfId : newCursorEtfId ?? state.cursorEtfId,
  };
}

/** A market is truly done for its targetLocalDate only once the forward sweep has reached the end
 * of the candidate universe AND every provisional (SOURCE_MISSING/NO_BAR) observation along the way
 * has since been confirmed away. Never true while a fetch failure has left candidates unclassified
 * partway through the sweep (sweepComplete simply never becomes true for those). */
export function isMarketDone(state: MarketCompletionState): boolean {
  return state.sweepComplete && state.pending.length === 0;
}
