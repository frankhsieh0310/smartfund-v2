// Vercel Durable Workflow — cloud-only autonomous resume for the ETF enrich-repair queue
// (production_scheduler_failures, job_id='YAHOO_ETF_ENRICH_REPAIR'). Same orchestration-only pattern
// as etf-full-sweep-cycle.ts: loop a bounded cloud endpoint with sleep() between calls until the
// queue is empty (endpoint reports remaining_in_queue === 0), or a safety cap is hit.

import { sleep } from "workflow";
import { runCronStep } from "./ingestion-steps";

export type EtfEnrichRepairCycleInput = {
  batch?: number;
  gapSeconds?: number;
  maxSlices?: number;
};

export async function etfEnrichRepairCycle(input: EtfEnrichRepairCycleInput = {}) {
  "use workflow";

  const batch = input.batch ?? 40;
  const gapMs = (input.gapSeconds ?? 20) * 1000;
  const maxSlices = input.maxSlices ?? 60; // 60 * 40 = 2,400 symbols of headroom per run

  let done = false;
  let slices = 0;
  let lastBody: unknown = null;

  while (!done && slices < maxSlices) {
    const result = (await runCronStep(
      `etf-enrich-repair-${slices}`,
      `/api/cron/yahoo-etf-enrich-repair?batch=${batch}`,
    )) as { body?: { remaining_in_queue?: number; attempted?: number } };
    lastBody = result;
    slices++;
    const remaining = result?.body?.remaining_in_queue ?? 0;
    const attempted = result?.body?.attempted ?? 0;
    done = remaining === 0 && attempted === 0; // nothing left to do this round
    if (!done) await sleep(gapMs);
  }

  return { completedAt: new Date().toISOString(), slices, done, lastSlice: lastBody };
}
