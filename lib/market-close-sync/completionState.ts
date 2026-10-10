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
//   FINAL (trusted the first time they're observed): NEW, CHANGED, SAME, DB_NEWER.
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

export type FinalOrPendingClassification = "NEW" | "CHANGED" | "SAME" | "DB_NEWER" | "SOURCE_MISSING" | "NO_BAR_FOR_TARGET_DATE";

export const NO_BAR_CONFIRM_DELAY_MS = 6 * 60 * 60 * 1000;

export type MarketCompletionState = {
  targetLocalDate: string;
  cursorEtfId: string; // forward sweep cursor; meaningless once sweepComplete is true
  sweepComplete: boolean; // true once the forward cursor scan has reached the end of the candidate universe at least once
  pending: PendingEntry[];
};

export function emptyState(targetLocalDate: string): MarketCompletionState {
  return { targetLocalDate, cursorEtfId: "", sweepComplete: false, pending: [] };
}

function applyObservation(
  pending: PendingEntry[],
  etfId: string,
  symbol: string,
  classification: FinalOrPendingClassification,
  nowMs: number,
): { pending: PendingEntry[] } {
  const existing = pending.find((p) => p.etfId === etfId);
  const withoutExisting = pending.filter((p) => p.etfId !== etfId);

  if (classification === "NEW" || classification === "CHANGED" || classification === "SAME" || classification === "DB_NEWER") {
    return { pending: withoutExisting }; // final the first time, always
  }

  if (classification === "SOURCE_MISSING") {
    if (existing?.state === "SOURCE_MISSING_PENDING") return { pending: withoutExisting }; // second confirmation -> final
    return { pending: [...withoutExisting, { etfId, symbol, state: "SOURCE_MISSING_PENDING", firstSeenAtMs: nowMs }] };
  }

  // NO_BAR_FOR_TARGET_DATE
  if (existing?.state === "NO_BAR_PENDING" && nowMs - existing.firstSeenAtMs >= NO_BAR_CONFIRM_DELAY_MS) {
    return { pending: withoutExisting }; // re-observed past the cooling-off window -> final
  }
  // Keep (or start) the pending entry, preserving the ORIGINAL firstSeenAtMs so the 6h window is
  // measured from when this ETF was first seen without a bar, never reset by a later re-check.
  const firstSeenAtMs = existing?.state === "NO_BAR_PENDING" ? existing.firstSeenAtMs : nowMs;
  return { pending: [...withoutExisting, { etfId, symbol, state: "NO_BAR_PENDING", firstSeenAtMs }] };
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
  for (const obs of outcome.observations) {
    pending = applyObservation(pending, obs.etfId, obs.symbol, obs.classification, nowMs).pending;
  }
  return {
    ...state,
    pending,
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
