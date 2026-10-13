// Vercel Durable Workflow — 共識雷達 daily orchestration (Phase 2, STEP 11).
//
// ONE daily Vercel Cron -> /api/workflows/bootstrap?workflow=consensus -> start(consensusCycle).
// The run then self-paces: 8 ingest passes 3h apart (00:20 / 03:20 / ... / 21:20 Asia/Taipei),
// then one aggregate pass (~06:30 Asia/Taipei on the next kick). No GitHub secret, no per-run
// manual op, no Windows. Each step just calls the already-deployed bounded cron endpoint with the
// project's own CRON_SECRET; the endpoint owns checkpoints + idempotency, so a replay is safe.

import { sleep } from "workflow";
import { runCronStep } from "./ingestion-steps";

export type ConsensusCycleInput = {
  passes?: number; // ingest passes this run (default 8 ≈ every 3h over the day)
  gapSeconds?: number; // spacing between passes (default 10800 = 3h)
  maxCandidates?: number; // per pass (default 20)
  lookbackHours?: number; // safety re-scan window (default 4)
};

export async function consensusCycle(input: ConsensusCycleInput = {}) {
  "use workflow";

  const passes = Math.max(1, Math.min(12, input.passes ?? 8));
  const gapMs = (input.gapSeconds ?? 10_800) * 1000;
  const maxc = input.maxCandidates ?? 20;
  const lookback = input.lookbackHours ?? 4;
  const results: unknown[] = [];

  for (let i = 0; i < passes; i++) {
    // source ingest never stops for AI: genuine raw events land as NEEDS_REVIEW regardless
    results.push(
      await runCronStep(
        `consensus-ingest#${i + 1}`,
        `/api/cron/consensus-ingest?maxCandidates=${maxc}&lookbackHours=${lookback}`,
      ),
    );
    // AI health probe + autonomous NEEDS_REVIEW backlog drain (self-heals the moment billing clears;
    // no-ops cheaply while AI is blocked). This step also re-aggregates when it reclassifies > 0.
    results.push(await runCronStep(`consensus-reprocess#${i + 1}`, `/api/cron/consensus-reprocess`));
    // viewpoint-flip detection over events that were newly classified / reclassified this pass (no AI)
    results.push(await runCronStep(`consensus-flips#${i + 1}`, `/api/cron/consensus-flips`));
    // deliver viewpoint-flip alerts (in-app + Expo push where a token is registered) — no AI
    results.push(await runCronStep(`consensus-push#${i + 1}`, `/api/cron/consensus-push`));
    if (i < passes - 1) await sleep(gapMs);
  }

  // Phase 9 — one bounded historical backfill pass per daily cycle. Checkpointed per source in
  // consensus_meta, so it walks ~180 days of real SEC/Fed history back over several days without a
  // manual op. Genuine statements land raw (NEEDS_REVIEW) while AI billing is blocked; it also runs
  // its own incremental aggregate + performance + FULL flip reconcile for the affected span.
  const backfill = await runCronStep("consensus-backfill", `/api/cron/consensus-backfill?days=180`);

  // final safety roll-up of 1D / 7D / 30D once the day's ingests + reprocessing have landed
  const aggregate = await runCronStep("consensus-aggregate", `/api/cron/consensus-aggregate`);
  // full flip reconciliation once the day's classification has settled
  const flips = await runCronStep("consensus-flips-reconcile", `/api/cron/consensus-flips?full=1`);
  const push = await runCronStep("consensus-push-reconcile", `/api/cron/consensus-push`);

  // historical accuracy: refresh 1M / 3M / 6M performance for any signal that newly matured today
  // (pure DB price lookups, no AI). Cheap; bounded batch inside the endpoint.
  const performance = await runCronStep("consensus-performance", `/api/cron/consensus-performance`);

  return { completedAt: new Date().toISOString(), passes, backfill, aggregate, performance, flips, push, results };
}

// Minimal PoC: 1 tiny ingest pass -> 60s -> aggregate. Genuine production ops at tiny batch size.
export async function consensusCyclePoc() {
  "use workflow";
  const ingest = await runCronStep("poc-consensus-ingest", `/api/cron/consensus-ingest?maxCandidates=5&lookbackHours=6`);
  await sleep("60s");
  const reprocess = await runCronStep("poc-consensus-reprocess", `/api/cron/consensus-reprocess`);
  await sleep("60s");
  const flips = await runCronStep("poc-consensus-flips", `/api/cron/consensus-flips`);
  await sleep("60s");
  const push = await runCronStep("poc-consensus-push", `/api/cron/consensus-push`);
  await sleep("60s");
  const aggregate = await runCronStep("poc-consensus-aggregate", `/api/cron/consensus-aggregate`);
  return { completedAt: new Date().toISOString(), ingest, reprocess, flips, push, aggregate };
}
