// FX forward-points reference curve — DB-side only, zero external fetch. Reads fx_forward_observations
// (populated by the existing FX forward-points ingestion) and materializes FORWARD_CURVE_POINT rows into
// fx_metrics via a single idempotent upsert. Same SQL as scripts/data/fx-forward-points/
// materialize-reference-curve.ts; ported to run on Vercel cron instead of a Windows Scheduled Task
// (see CLAUDE.md "正式資料排程一律在雲端執行") — logic, including the upsert's ON CONFLICT clause, is
// unchanged, only the local health/checkpoint JSON files are replaced by production_scheduler_runs.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "FX_FORWARD_POINTS_REFERENCE_CURVE";
const PROVIDER = "BANK_OF_ENGLAND_IADB";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const runKey = hourBucketKey("fx-forward-reference-curve");
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: 0, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey });

  try {
    const before = (await prisma.$queryRawUnsafe<{ rows: number }[]>(
      `SELECT COUNT(*)::int rows FROM fx_metrics WHERE metric='FORWARD_CURVE_POINT'`,
    ))[0].rows;

    await prisma.$executeRawUnsafe(
      `INSERT INTO fx_metrics(pair_symbol,interval,metric,observed_at,value,payload,source,computed_at)
       SELECT o.pair,o.tenor,'FORWARD_CURVE_POINT',o.observation_date,o.forward_outright,
         jsonb_build_object('pairId',o.pair,'baseCurrency',o.base_currency,'quoteCurrency',o.quote_currency,
           'tenor',o.tenor,'currency',o.currency,'sourceObservationId',o.id,'sourceRecordId',o.source_record_id,
           'sourceUrl',o.source_url,'asOf',o.observation_date,'knownAt',COALESCE(o.retrieved_at,o.updated_at,o.created_at),
           'valueType','SOURCE_REPORTED_FORWARD_OUTRIGHT','deliveryType','DELIVERABLE_FORWARD','interpolated',false,
           'calculationVersion','FX_FORWARD_REFERENCE_CURVE_V1'),
         'BANK_OF_ENGLAND_IADB',NOW()
       FROM fx_forward_observations o
       WHERE o.forward_outright IS NOT NULL AND o.direct_or_derived='DIRECT_FORWARD_OUTRIGHT'
       ON CONFLICT(pair_symbol,interval,metric,observed_at) DO UPDATE SET
         value=EXCLUDED.value, payload=EXCLUDED.payload, source=EXCLUDED.source, computed_at=NOW()`,
    );

    const stats = (await prisma.$queryRawUnsafe<{ rows: number; pairs: number; tenors: number; earliest: string | null; latest: string | null }[]>(
      `SELECT COUNT(*)::int rows,COUNT(DISTINCT pair_symbol)::int pairs,COUNT(DISTINCT interval)::int tenors,
              MIN(observed_at)::text earliest, MAX(observed_at)::text latest
         FROM fx_metrics WHERE metric='FORWARD_CURVE_POINT'`,
    ))[0];
    const ndf = (await prisma.$queryRawUnsafe<{ rows: number; pairs: number }[]>(
      `SELECT COUNT(*)::int rows,COUNT(DISTINCT pair)::int pairs FROM fx_forward_observations
        WHERE value_type='NDF' OR direct_or_derived ILIKE '%NDF%'`,
    ))[0];

    const rowsAdded = Math.max(0, stats.rows - before);
    await finishRun(runId, JOB, PROVIDER, startedMs, {
      status: "COMPLETED", attempted: stats.rows, completed: stats.rows, inserted: rowsAdded, updated: 0, failed: 0,
      retryableFailures: 0, checkpointAfter: null,
      details: { before, after: stats.rows, forwardPairs: stats.pairs, tenors: stats.tenors, ndf, earliest: stats.earliest, latest: stats.latest },
    });

    return Response.json({ ok: true, job: JOB, runId, before, after: stats.rows, rowsAdded, forwardPairs: stats.pairs, tenors: stats.tenors, ndf, runtimeMs: Date.now() - startedMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, JOB, PROVIDER, startedMs, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 0, checkpointAfter: null, error: message });
    return Response.json({ ok: false, job: JOB, runId, error: message }, { status: 500 });
  }
}
