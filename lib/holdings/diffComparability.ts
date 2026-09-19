// Pure comparability rules for a two-period holdings diff. A position missing from the later
// snapshot only means "exited" when BOTH snapshots are complete portfolios from the same
// disclosure; otherwise it may simply have fallen outside a truncated (Top-N / partial) list.
import type { CoverageDepth } from "./coverageDepth";
import type { HoldingsDiffEntry } from "./holdingsAnalysis";

export type SnapshotDepth = {
  date: string | null;
  source: string | null;
  coverageDepth: CoverageDepth;
  /** rows actually stored (weight present) */
  presentRowCount: number;
  /** count the source declares for the full portfolio, when known */
  declaredCount: number | null;
};

export type DiffComparability = {
  level: "FULL_VS_FULL" | "CONSERVATIVE";
  reason:
    | "BOTH_COMPLETE_SAME_SOURCE"
    | "LATEST_INCOMPLETE"
    | "PREVIOUS_INCOMPLETE"
    | "BOTH_INCOMPLETE"
    | "SOURCE_MISMATCH";
  warning: string | null;
  previous: SnapshotDepth;
  latest: SnapshotDepth;
};

/** Complete = confirmed FULL disclosure, or every declared position (more than a top-10) is present. */
export function isCompleteSnapshot(s: SnapshotDepth): boolean {
  if (s.coverageDepth === "FULL") return true;
  return s.declaredCount != null && s.declaredCount > 10 && s.presentRowCount >= s.declaredCount;
}

export function assessDiffComparability(previous: SnapshotDepth, latest: SnapshotDepth): DiffComparability {
  const prevOk = isCompleteSnapshot(previous);
  const latestOk = isCompleteSnapshot(latest);
  if (prevOk && latestOk && previous.source === latest.source) {
    return { level: "FULL_VS_FULL", reason: "BOTH_COMPLETE_SAME_SOURCE", warning: null, previous, latest };
  }
  const reason = prevOk && latestOk ? "SOURCE_MISMATCH" : !prevOk && !latestOk ? "BOTH_INCOMPLETE" : !latestOk ? "LATEST_INCOMPLETE" : "PREVIOUS_INCOMPLETE";
  return {
    level: "CONSERVATIVE",
    reason,
    warning: "兩期持股資料完整度不同或不完整，無法可靠判定新增／退出，僅比較兩期都有的持股權重變化。",
    previous,
    latest,
  };
}

export type ComparedDiff = {
  entries: HoldingsDiffEntry[]; // ADDED/REMOVED only present when FULL_VS_FULL
  newlyDisclosed: HoldingsDiffEntry[]; // only in latest snapshot, not provably "added"
  noLongerDisclosed: HoldingsDiffEntry[]; // only in previous snapshot, not provably "exited"
};

export function applyComparability(all: HoldingsDiffEntry[], comparability: DiffComparability): ComparedDiff {
  if (comparability.level === "FULL_VS_FULL") return { entries: all, newlyDisclosed: [], noLongerDisclosed: [] };
  return {
    entries: all.filter((e) => e.change !== "ADDED" && e.change !== "REMOVED"),
    newlyDisclosed: all.filter((e) => e.change === "ADDED"),
    noLongerDisclosed: all.filter((e) => e.change === "REMOVED"),
  };
}
