// Vercel Durable Workflow — cloud-only backfill of ETF distribution history for ETFs the full sweep
// already priced but never captured dividends for (see /api/cron/yahoo-etf-distribution-backfill).
// Completely separate from etfFullSweepCycle: different job_id, different lease, does not touch the
// full-sweep checkpoint or its Durable Workflow run.

import { sleep } from "workflow";
import { runCronStep } from "./ingestion-steps";

export type EtfDistributionBackfillCycleInput = { batch?: number; gapSeconds?: number; maxSlices?: number };

export async function etfDistributionBackfillCycle(input: EtfDistributionBackfillCycleInput = {}) {
  "use workflow";

  // 2026-09-11 fix: default batch lowered (50->35) as extra headroom alongside the endpoint's own
  // tightened internal deadline (see route.ts) — smaller slices, less chance any one of them runs
  // long enough to hit the workflow step's own fetch timeout.
  const batch = input.batch ?? 35;
  const gapMs = (input.gapSeconds ?? 20) * 1000;
  const maxSlices = input.maxSlices ?? 300;

  let done = false;
  let slices = 0;
  let lastBody: unknown = null;
  while (!done && slices < maxSlices) {
    const result = (await runCronStep(
      `etf-distribution-backfill-${slices}`,
      `/api/cron/yahoo-etf-distribution-backfill?batch=${batch}`,
    )) as { body?: { scan_complete?: boolean } };
    lastBody = result;
    slices++;
    // 2026-09-11 fix: completion must come from the endpoint's explicit scan_complete flag, never
    // inferred from attempted===0 — a SKIP_LOCKED/error response has no `attempted` field either, and
    // the old `(remaining ?? 0) === 0 && (attempted ?? 0) === 0` check silently read that missing-field
    // shape as "done", terminating the loop on the very first transient hiccup it hit.
    done = result?.body?.scan_complete === true;
    if (!done) await sleep(gapMs);
  }

  return { completedAt: new Date().toISOString(), slices, done, lastSlice: lastBody };
}
