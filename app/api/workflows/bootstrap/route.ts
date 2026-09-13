// Durable-workflow bootstrap — isolated recovery extraction (2026-09-13). Trimmed to only the 4
// workflows this round needs (yahoo-etf-full-sweep, yahoo-fund-full-sweep,
// yahoo-etf-distribution-backfill, yahoo-etf-enrich-repair); the production route also serves
// poc/retry/consensus/ingestion/fund-enrich-repair, intentionally left out here per the recovery
// task's own "don't pull in unrelated" scope. A single daily Vercel Cron hits this (Bearer
// CRON_SECRET) and it start()s a durable Workflow run that self-paces the ingestion batches with
// sleep(). No GitHub scheduler, no external secret sync, no Windows, no per-hour manual operation.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { start } from "workflow/api";
import { etfFullSweepCycle } from "@/app/workflows/etf-full-sweep-cycle";
import { etfEnrichRepairCycle } from "@/app/workflows/etf-enrich-repair-cycle";
import { fundFullSweepCycle } from "@/app/workflows/fund-full-sweep-cycle";
import { etfDistributionBackfillCycle } from "@/app/workflows/etf-distribution-backfill-cycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const which = (new URL(request.url).searchParams.get("workflow") ?? "").toLowerCase();

  let run;
  if (which === "yahoo-etf-full-sweep") run = await start(etfFullSweepCycle, [{}]);
  else if (which === "yahoo-etf-enrich-repair") {
    const qp = new URL(request.url).searchParams;
    const batch = qp.get("batch") ? Number(qp.get("batch")) : undefined;
    const maxSlices = qp.get("maxSlices") ? Number(qp.get("maxSlices")) : undefined;
    run = await start(etfEnrichRepairCycle, [{ batch, maxSlices }]);
  }
  else if (which === "yahoo-fund-full-sweep") run = await start(fundFullSweepCycle, [{}]);
  else if (which === "yahoo-etf-distribution-backfill") {
    const qp = new URL(request.url).searchParams;
    const batch = qp.get("batch") ? Number(qp.get("batch")) : undefined;
    const maxSlices = qp.get("maxSlices") ? Number(qp.get("maxSlices")) : undefined;
    run = await start(etfDistributionBackfillCycle, [{ batch, maxSlices }]);
  }
  else return Response.json({ ok: false, task: "workflow-bootstrap", error: `Unknown or unsupported workflow: ${which}. This recovery build only serves yahoo-etf-full-sweep|yahoo-fund-full-sweep|yahoo-etf-distribution-backfill|yahoo-etf-enrich-repair.` }, { status: 400 });

  return Response.json({
    ok: true,
    task: "workflow-bootstrap",
    workflow: which,
    runId: (run as { runId?: string })?.runId ?? null,
    startedAt: new Date().toISOString(),
  });
}
