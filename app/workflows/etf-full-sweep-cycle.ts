// Vercel Durable Workflow — cloud-only autonomous resume for the Yahoo ETF full sweep.
//
// Orchestration only: each iteration calls the already-deployed bounded /api/cron/yahoo-etf-full-sweep
// endpoint as a step, then sleep()s, then calls it again — reading the SAME checkpoint
// ('yahoo-etf-full-sweep') the endpoint owns. No ingestion logic lives here. A workflow replay never
// restarts the universe sweep: the endpoint's own DB checkpoint + concurrency lock make every step
// idempotent and resumable exactly where it left off, whether that's a fresh start, a step retry, or a
// brand new workflow run kicked off by the daily safety-net cron below.
//
// Started once (by the daily bootstrap cron, or a manual bootstrap call) and it self-paces via
// sleep() until the checkpoint wraps a full lap — no Vercel Cron cadence shorter than daily is needed,
// no Windows process, no manual curl loop.

import { sleep } from "workflow";
import { runCronStep } from "./ingestion-steps";

export type EtfFullSweepCycleInput = {
  batch?: number;
  gapSeconds?: number;
  maxSlices?: number; // safety cap so one workflow run stays well under Vercel Workflow event limits
};

export async function etfFullSweepCycle(input: EtfFullSweepCycleInput = {}) {
  "use workflow";

  const batch = input.batch ?? 75;
  const gapMs = (input.gapSeconds ?? 30) * 1000;
  const maxSlices = input.maxSlices ?? 400; // 400 * 75 = 30,000 ETFs of headroom, well past the ~16.8k universe

  let wrapped = false;
  let slices = 0;
  let lastBody: unknown = null;

  while (!wrapped && slices < maxSlices) {
    const result = (await runCronStep(
      `etf-full-sweep-${slices}`,
      `/api/cron/yahoo-etf-full-sweep?batch=${batch}`,
    )) as { body?: { wrapped?: boolean; skipped?: boolean; reason?: string } };
    lastBody = result;
    slices++;
    wrapped = !!result?.body?.wrapped;
    if (!wrapped) await sleep(gapMs);
  }

  return { completedAt: new Date().toISOString(), slices, wrapped, lastSlice: lastBody };
}
