// Vercel Durable Workflow — cloud-only autonomous resume for the Fund enrich-repair queue
// (production_scheduler_failures, job_id='YAHOO_FUND_ENRICH_REPAIR').

import { sleep } from "workflow";
import { runCronStep } from "./ingestion-steps";

export type FundEnrichRepairCycleInput = {
  batch?: number;
  gapSeconds?: number;
  maxSlices?: number;
};

export async function fundEnrichRepairCycle(input: FundEnrichRepairCycleInput = {}) {
  "use workflow";

  const batch = input.batch ?? 40;
  const gapMs = (input.gapSeconds ?? 20) * 1000;
  const maxSlices = input.maxSlices ?? 60;

  let done = false;
  let slices = 0;
  let lastBody: unknown = null;
  while (!done && slices < maxSlices) {
    const result = (await runCronStep(
      `fund-enrich-repair-${slices}`,
      `/api/cron/yahoo-fund-enrich-repair?batch=${batch}`,
    )) as { body?: { remaining_in_queue?: number; attempted?: number } };
    lastBody = result;
    slices++;
    const remaining = result?.body?.remaining_in_queue ?? 0;
    const attempted = result?.body?.attempted ?? 0;
    done = remaining === 0 && attempted === 0;
    if (!done) await sleep(gapMs);
  }

  return { completedAt: new Date().toISOString(), slices, done, lastSlice: lastBody };
}
