// Task L: per-invocation scheduling fairness. Before this, route.ts walked consideredJobIds in one
// fixed pass, giving each eligible market the ENTIRE remaining time budget for both its sweep and
// its confirmation recheck — which let one huge market (UK, ~5,700 ETFs) consume a full 240s
// invocation by itself, so every market after it in the list reported NOT_REACHED, invocation after
// invocation (confirmed live in Task K's 6-call test run). Two independent fixes, both pure/testable
// here; route.ts supplies the real clock and state:
//
//   1. Priority: a market still mid-sweep (or not yet started) is strictly higher priority than a
//      market only waiting on a confirmation recheck — "尚未掃描的市場" go first, "到期需確認的項目"
//      after. A recheck-only market whose pending entries aren't due yet (NO_BAR's 6h window,
//      SOURCE_MISSING's own minimum re-check spacing) is skipped entirely this invocation — never
//      queried early, per the task's explicit "到期前不得重新查詢".
//   2. Per-market time cap: no single market's processing within one invocation may exceed 40% of
//      the TOTAL time budget (not 40% of whatever remains) — so even an enormous market gets cut off
//      and the loop moves on to the next one, within the SAME invocation, rather than monopolizing it.

import type { MarketCompletionState, PendingEntry } from "./completionState.ts";
import { NO_BAR_CONFIRM_DELAY_MS } from "./completionState.ts";

export const PER_MARKET_BUDGET_FRACTION = 0.4;

// SOURCE_MISSING has no explicit re-check delay elsewhere in this codebase (Task K's two-confirmation
// rule never specified a minimum SPACING between the two observations) — without one, a market whose
// sweep spans multiple batches in the SAME invocation could trivially "confirm" a SOURCE_MISSING
// symbol by observing it twice seconds apart, which isn't a meaningfully separate look. This mirrors
// the production cron's own cadence (vercel.json: every 15 minutes) as the minimum gap between two
// observations that count as independent.
export const SOURCE_MISSING_MIN_RECHECK_DELAY_MS = 15 * 60 * 1000;

export function minRecheckDelayFor(entry: PendingEntry): number {
  return entry.state === "NO_BAR_PENDING" ? NO_BAR_CONFIRM_DELAY_MS : SOURCE_MISSING_MIN_RECHECK_DELAY_MS;
}

export function isDueForRecheck(entry: PendingEntry, nowMs: number): boolean {
  return nowMs - entry.firstSeenAtMs >= minRecheckDelayFor(entry);
}

export type MarketPriority =
  | { kind: "SWEEP" } // not yet sweepComplete — needs scanning, highest priority
  | { kind: "RECHECK_DUE"; dueCount: number } // sweepComplete, at least one pending entry is due
  | { kind: "WAITING" } // sweepComplete, has pending entries, but none due yet
  | { kind: "DONE" }; // sweepComplete, nothing pending

export function classifyMarketPriority(state: MarketCompletionState, nowMs: number): MarketPriority {
  if (!state.sweepComplete) return { kind: "SWEEP" };
  if (state.pending.length === 0) return { kind: "DONE" };
  const dueCount = state.pending.filter((p) => isDueForRecheck(p, nowMs)).length;
  return dueCount > 0 ? { kind: "RECHECK_DUE", dueCount } : { kind: "WAITING" };
}

/**
 * Orders a list of eligible markets for one invocation: all SWEEP-priority markets first (in their
 * original relative order), then all RECHECK_DUE markets (in their original relative order). WAITING
 * and DONE markets are dropped entirely — there is nothing for this invocation to do with them.
 * Pure function of the priorities alone; route.ts is responsible for actually bounding each market's
 * processing time once it gets its turn (see PER_MARKET_BUDGET_FRACTION).
 */
export function orderMarketsForInvocation<T>(markets: Array<{ item: T; priority: MarketPriority }>): T[] {
  const sweep = markets.filter((m) => m.priority.kind === "SWEEP").map((m) => m.item);
  const recheckDue = markets.filter((m) => m.priority.kind === "RECHECK_DUE").map((m) => m.item);
  return [...sweep, ...recheckDue];
}

/**
 * Pure simulation of the fairness policy, used by the test suite to prove no market is starved
 * indefinitely. Each market is modeled only by how many "units of work" (batches) its sweep needs;
 * one invocation gives each SWEEP-priority market, in order, up to `perMarketBatchCap` batches (the
 * 40%-of-budget cap translated into batch counts for the simulation) before moving to the next,
 * until the whole invocation's `totalBatchBudget` is exhausted. Returns the number of invocations
 * needed before every market's sweep is fully consumed.
 */
// Task W2: the shared lib/cloud-ingestion/runContext.ts `hourBucketKey` dedups by calendar UTC HOUR,
// not by the cron's actual 15-minute interval (vercel.json), so two invocations in the same hour
// collapse onto one run_key and the later one's row silently overwrites the earlier one's via
// beginRun's ON CONFLICT...DO UPDATE — confirmed live in Production (Task P2/W: only the LAST
// invocation per hour was independently recoverable from production_scheduler_runs). Fixed here
// rather than in runContext.ts: that file is shared by other cron jobs this task is not authorized
// to touch, so market-close-sync computes its own finer-grained key instead of changing shared infra.
export function fifteenMinuteBucketKey(prefix: string, now: Date = new Date()): string {
  const bucketMinute = Math.floor(now.getUTCMinutes() / 15) * 15;
  const datePart = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return `${prefix}:${datePart}:${String(bucketMinute).padStart(2, "0")}`;
}

export function simulateRoundsToSweepAll(marketBatchCounts: number[], perMarketBatchCap: number, totalBatchBudget: number): number {
  const remaining = [...marketBatchCounts];
  let rounds = 0;
  const maxRoundsGuard = 10_000; // generous; a real infinite-starvation bug would never terminate otherwise
  while (remaining.some((r) => r > 0)) {
    rounds++;
    if (rounds > maxRoundsGuard) throw new Error("simulateRoundsToSweepAll: exceeded guard — a market is being starved");
    let budgetLeftThisRound = totalBatchBudget;
    for (let i = 0; i < remaining.length && budgetLeftThisRound > 0; i++) {
      if (remaining[i] <= 0) continue;
      const take = Math.min(remaining[i], perMarketBatchCap, budgetLeftThisRound);
      remaining[i] -= take;
      budgetLeftThisRound -= take;
    }
  }
  return rounds;
}
