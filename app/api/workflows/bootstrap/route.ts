// Durable-workflow bootstrap. A single daily Vercel Cron hits this (Bearer CRON_SECRET) and it
// start()s a durable Workflow run that self-paces the ingestion batches with sleep(). No GitHub
// scheduler, no external secret sync, no Windows, no per-hour manual operation.
//
//   ?workflow=full   (default) -> ingestionCycle: 5 bounded batches, sleep between, ~24h of passes
//   ?workflow=poc              -> ingestionCyclePoc: 1 small ETF batch -> sleep 60s -> 1 small NAV batch
//   ?workflow=retry            -> retryProbeWorkflow: controlled transient-error step + auto-retry
//   ?workflow=consensus        -> consensusCycle: 8 consensus-ingest passes 3h apart + aggregate
//   ?workflow=consensus-poc    -> consensusCyclePoc: 1 tiny ingest -> 60s -> aggregate
//   ?workflow=yahoo-etf-full-sweep -> etfFullSweepCycle: loops the bounded cloud ETF full-sweep
//     endpoint (checkpoint 'yahoo-etf-full-sweep') until it wraps a full lap. Idempotent to
//     re-bootstrap: the endpoint's own checkpoint + concurrency lock make a second run a no-op
//     while the first is still in flight. The daily cron below only re-starts it if a prior run
//     ended (e.g. a redeploy) without finishing.
//   ?workflow=yahoo-etf-enrich-repair -> etfEnrichRepairCycle: loops the bounded cloud enrich-repair
//     endpoint (production_scheduler_failures, job_id=YAHOO_ETF_ENRICH_REPAIR) until the queue is
//     drained for this pass.
//   ?workflow=yahoo-fund-full-sweep -> fundFullSweepCycle: discovers the US mutual-fund universe once
//     then loops the bounded cloud fund full-sweep endpoint (checkpoint 'yahoo-fund-full-sweep').
//   ?workflow=yahoo-fund-enrich-repair -> fundEnrichRepairCycle: loops the bounded cloud fund
//     enrich-repair endpoint (job_id=YAHOO_FUND_ENRICH_REPAIR) until the queue is drained.
//   ?workflow=yahoo-etf-distribution-backfill -> etfDistributionBackfillCycle: loops the bounded
//     dividend-only backfill endpoint (job_id=YAHOO_ETF_DISTRIBUTION_BACKFILL) for ETFs the full sweep
//     already priced but never captured distribution history for. Independent of the full sweep.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { start } from "workflow/api";
import { ingestionCycle, ingestionCyclePoc } from "@/app/workflows/ingestion-cycle";
import { consensusCycle, consensusCyclePoc } from "@/app/workflows/consensus-cycle";
import { retryProbeWorkflow } from "@/app/workflows/retry-probe";
import { etfFullSweepCycle } from "@/app/workflows/etf-full-sweep-cycle";
import { etfEnrichRepairCycle } from "@/app/workflows/etf-enrich-repair-cycle";
import { fundFullSweepCycle } from "@/app/workflows/fund-full-sweep-cycle";
import { fundEnrichRepairCycle } from "@/app/workflows/fund-enrich-repair-cycle";
import { etfDistributionBackfillCycle } from "@/app/workflows/etf-distribution-backfill-cycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const which = (new URL(request.url).searchParams.get("workflow") ?? "full").toLowerCase();

  let run;
  if (which === "poc") run = await start(ingestionCyclePoc, []);
  else if (which === "retry") run = await start(retryProbeWorkflow, []);
  else if (which === "consensus") run = await start(consensusCycle, [{}]);
  else if (which === "consensus-poc") run = await start(consensusCyclePoc, []);
  else if (which === "yahoo-etf-full-sweep") run = await start(etfFullSweepCycle, [{}]);
  else if (which === "yahoo-etf-enrich-repair") {
    const qp = new URL(request.url).searchParams;
    const batch = qp.get("batch") ? Number(qp.get("batch")) : undefined;
    const maxSlices = qp.get("maxSlices") ? Number(qp.get("maxSlices")) : undefined;
    run = await start(etfEnrichRepairCycle, [{ batch, maxSlices }]);
  }
  else if (which === "yahoo-fund-full-sweep") run = await start(fundFullSweepCycle, [{}]);
  else if (which === "yahoo-fund-enrich-repair") {
    const qp = new URL(request.url).searchParams;
    const batch = qp.get("batch") ? Number(qp.get("batch")) : undefined;
    const maxSlices = qp.get("maxSlices") ? Number(qp.get("maxSlices")) : undefined;
    run = await start(fundEnrichRepairCycle, [{ batch, maxSlices }]);
  }
  else if (which === "yahoo-etf-distribution-backfill") {
    const qp = new URL(request.url).searchParams;
    const batch = qp.get("batch") ? Number(qp.get("batch")) : undefined;
    const maxSlices = qp.get("maxSlices") ? Number(qp.get("maxSlices")) : undefined;
    run = await start(etfDistributionBackfillCycle, [{ batch, maxSlices }]);
  }
  else run = await start(ingestionCycle, [{}]);

  return Response.json({
    ok: true,
    task: "workflow-bootstrap",
    workflow: which,
    runId: (run as { runId?: string })?.runId ?? null,
    startedAt: new Date().toISOString(),
  });
}
