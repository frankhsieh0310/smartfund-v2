// Vercel Durable Workflow — cloud ingestion orchestration PoC.
//
// This workflow ONLY orchestrates: it calls the already-deployed bounded cloud ingestion endpoints
// as steps, with sleep() between them. No ingestion logic is duplicated. The endpoints keep their
// own DB checkpoints (production_scheduler_checkpoints) and idempotency, so a workflow replay /
// redeploy never restarts a universe sweep — it just re-issues the same bounded call, which the
// endpoint no-ops if already fresh.
//
// Steps read process.env.CRON_SECRET at runtime (the value already lives on the Vercel project), so
// no external secret sync and no GitHub secret are needed.

import { sleep } from "workflow";
import { runCronStep } from "./ingestion-steps";

export type IngestionCycleInput = {
  etfBatch?: number;
  fundNavBatch?: number;
  moneydjEtfBatch?: number;
  globalEtfBatch?: number;
  fundHoldingsBatch?: number;
  gapSeconds?: number;
};

/**
 * One full ingestion pass: five bounded batches paced by sleep(). A daily bootstrap starts one run;
 * the run loops for ~24h then returns, and the next day's bootstrap starts a fresh run (keeps each
 * run well under the 25,000-events / 2 GB per-run limits).
 */
export async function ingestionCycle(input: IngestionCycleInput = {}) {
  "use workflow";

  const gapMs = (input.gapSeconds ?? 600) * 1000;
  const results: Record<string, unknown> = {};

  results.etfPrice = await runCronStep("etf-price", `/api/cron/cloud-etf-price?batch=${input.etfBatch ?? 500}`);
  await sleep(gapMs);

  results.fundNav = await runCronStep("fund-nav", `/api/cron/cloud-fund-nav?provider=ALL&batch=${input.fundNavBatch ?? 200}`);
  await sleep(gapMs);

  results.moneydjEtf = await runCronStep("moneydj-etf", `/api/cron/cloud-moneydj-etf?batch=${input.moneydjEtfBatch ?? 150}`);
  await sleep(gapMs);

  results.globalEtfHoldings = await runCronStep(
    "global-etf-holdings",
    `/api/cron/cloud-global-etf-holdings?provider=ALL&batch=${input.globalEtfBatch ?? 100}`,
  );
  await sleep(gapMs);

  results.fundHoldings = await runCronStep(
    "fund-holdings",
    `/api/cron/cloud-fund-holdings?provider=ALL&batch=${input.fundHoldingsBatch ?? 150}`,
  );

  return { completedAt: new Date().toISOString(), results };
}

/**
 * Minimal PoC entry: ONE small ETF-price batch -> sleep 60s -> ONE small fund-NAV batch. Genuine
 * production operations at tiny batch sizes; if everything is already fresh the endpoints return
 * NO_CHANGE (near-zero cost).
 */
export async function ingestionCyclePoc() {
  "use workflow";

  const etf = await runCronStep("poc-etf-price", `/api/cron/cloud-etf-price?batch=20`);
  await sleep("60s");
  const fundNav = await runCronStep("poc-fund-nav", `/api/cron/cloud-fund-nav?provider=ALL&batch=10`);

  return { completedAt: new Date().toISOString(), etf, fundNav };
}
