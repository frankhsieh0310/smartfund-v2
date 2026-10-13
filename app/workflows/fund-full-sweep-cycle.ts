// Vercel Durable Workflow — cloud-only autonomous resume for the Yahoo US mutual-fund full sweep.
// Orchestration only: discover once, then loop the bounded sweep endpoint (checkpoint
// 'yahoo-fund-full-sweep') with sleep() between calls until it wraps a full lap.

import { sleep } from "workflow";
import { runCronStep } from "./ingestion-steps";

export type FundFullSweepCycleInput = {
  batch?: number;
  gapSeconds?: number;
  maxSlices?: number;
};

export async function fundFullSweepCycle(input: FundFullSweepCycleInput = {}) {
  "use workflow";

  const batch = input.batch ?? 50;
  const gapMs = (input.gapSeconds ?? 30) * 1000;
  const maxSlices = input.maxSlices ?? 700; // 700 * 50 = 35,000 symbols of headroom vs the ~27.4k universe

  const discoverResult = await runCronStep("fund-full-sweep-discover", "/api/cron/yahoo-fund-full-sweep?phase=discover");

  let wrapped = false;
  let slices = 0;
  let lastBody: unknown = null;
  while (!wrapped && slices < maxSlices) {
    const result = (await runCronStep(
      `fund-full-sweep-${slices}`,
      `/api/cron/yahoo-fund-full-sweep?batch=${batch}`,
    )) as { body?: { wrapped?: boolean } };
    lastBody = result;
    slices++;
    wrapped = !!result?.body?.wrapped;
    if (!wrapped) await sleep(gapMs);
  }

  return { completedAt: new Date().toISOString(), discoverResult, slices, wrapped, lastSlice: lastBody };
}
