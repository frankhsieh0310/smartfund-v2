import { createHash } from "node:crypto";

export type ConditionState = "UNKNOWN" | "BELOW" | "ABOVE" | "INSIDE" | "OUTSIDE" | "TRUE" | "FALSE";
export type RuleKind = "ABOVE" | "BELOW" | "CROSSES_ABOVE" | "CROSSES_BELOW" | "ABS_CHANGE" | "PERCENT_CHANGE" | "NEW_HIGH" | "NEW_LOW" | "VOLUME_ANOMALY" | "EVENT";
export type Evaluation = { matched: boolean; triggered: boolean; suppressed: boolean; nextState: ConditionState; rearmed: boolean; reason: string };

export function dedupeKey(ruleId: string, ruleVersionId: string, inputId: string, revisionId: string | null, transition: string) {
  return createHash("sha256").update([ruleId, ruleVersionId, inputId, revisionId ?? "", transition].join("|")).digest("hex");
}

export function evaluateThreshold(input: {
  kind: RuleKind; threshold: number; current: number; previous: number | null;
  priorState: ConditionState; cooldownUntil?: Date | null; now: Date; periodicRepeat?: boolean;
}): Evaluation {
  const { kind, threshold, current, previous, priorState, cooldownUntil, now, periodicRepeat = false } = input;
  const nextState: ConditionState = current > threshold ? "ABOVE" : "BELOW";
  const cooling = Boolean(cooldownUntil && cooldownUntil.getTime() > now.getTime());
  const crossedAbove = previous !== null && previous <= threshold && current > threshold;
  const crossedBelow = previous !== null && previous >= threshold && current < threshold;
  let matched = false;
  let transition = false;
  if (kind === "ABOVE") { matched = current > threshold; transition = matched && (priorState !== "ABOVE" || periodicRepeat); }
  if (kind === "BELOW") { matched = current < threshold; transition = matched && (priorState !== "BELOW" || periodicRepeat); }
  if (kind === "CROSSES_ABOVE") { matched = crossedAbove; transition = crossedAbove; }
  if (kind === "CROSSES_BELOW") { matched = crossedBelow; transition = crossedBelow; }
  const triggered = transition && !cooling;
  return { matched, triggered, suppressed: transition && cooling, nextState, rearmed: (priorState === "ABOVE" && nextState === "BELOW") || (priorState === "BELOW" && nextState === "ABOVE"), reason: previous === null && kind.startsWith("CROSSES") ? "WAITING_FOR_PREVIOUS_OBSERVATION" : cooling ? "COOLDOWN" : triggered ? "STATE_TRANSITION" : "NO_TRANSITION" };
}

export function rollingReference<T extends { observedAt: Date; value: number }>(history: T[], referenceAt: Date) {
  return history.filter((row) => row.observedAt <= referenceAt).sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0] ?? null;
}

export function rollingExtreme(history: Array<{ observedAt: Date; value: number }>, from: Date, to: Date, kind: "HIGH" | "LOW") {
  const values = history.filter((row) => row.observedAt >= from && row.observedAt < to).map((row) => row.value);
  if (!values.length) return null;
  return kind === "HIGH" ? Math.max(...values) : Math.min(...values);
}

export function isMaterialEventRevision(before: Record<string, unknown>, after: Record<string, unknown>) {
  return ["status", "eventAt", "amount", "currency", "outcome"].some((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
