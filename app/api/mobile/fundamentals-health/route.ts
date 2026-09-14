// Read-only fundamentals freshness health check. No writes, no new UI — just exposes what's already
// true in stock_financial_facts + production_scheduler_runs so staleness is observable without a DB shell.
import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const CURRENT_WITHIN_DAYS = { pe: 3, fundamentals: 100 }; // PE: within a few trading days; quarterly facts: within ~1 quarter + buffer

async function pct(metric: string, source: string | null, exchanges: string[], withinDays: number, totalActive: number) {
  if (totalActive === 0) return { current: 0, pct: 0 };
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(DISTINCT f.stock_id)::int n
       FROM stock_financial_facts f JOIN stocks s ON s.id = f.stock_id
      WHERE f.metric = $1 ${source ? "AND f.source = $2" : ""} AND s.exchange = ANY($${source ? 3 : 2}::text[])
        AND s.is_active = true AND f.period_end >= (CURRENT_DATE - $${source ? 4 : 3}::int)`,
    ...(source ? [metric, source, exchanges, withinDays] : [metric, exchanges, withinDays]),
  );
  const current = rows[0]?.n ?? 0;
  return { current, pct: Math.round((current / totalActive) * 1000) / 10 };
}

// NOTE: `WHERE source = ...` / `WHERE source LIKE ...` alone has no supporting index on this
// 16.7M-row table (only (source, publication_date) and (metric, period_end) composites exist) and
// times out as a full scan — found the hard way while building this endpoint. So `latest_as_of` here
// is always passed in, already computed via a metric-scoped query elsewhere (indexed, sub-100ms).
async function runLogFor(jobId: string, latestAsOf: string | null) {
  const runs = await prisma.$queryRawUnsafe<Array<{ status: string; completed_at: string | null; started_at: string; inserted: number; completed: number; details: unknown }>>(
    `SELECT status, completed_at::text, started_at::text, inserted, completed, details FROM production_scheduler_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 30`,
    jobId,
  );
  const lastSuccess = runs.find((r) => r.status === "COMPLETED" || r.status === "PARTIAL");
  const lastFailure = runs.find((r) => r.status === "FAILED");
  const last24h = runs.filter((r) => new Date(r.started_at).getTime() >= Date.now() - 86_400_000);
  return {
    last_success: lastSuccess?.completed_at ?? null,
    last_failure: lastFailure?.completed_at ?? null,
    latest_as_of: latestAsOf,
    rows_updated: lastSuccess?.inserted ?? null,
    rows_updated_24h: last24h.reduce((sum, r) => sum + (r.inserted ?? 0), 0),
    completed_24h: last24h.reduce((sum, r) => sum + (r.completed ?? 0), 0),
    last_run_details: lastSuccess?.details ?? null,
  };
}

export async function GET() {
  const [twTotal, usTotal] = await Promise.all([
    prisma.stock.count({ where: { isActive: true, exchange: { in: ["TWSE", "TPEx", "TPEX"] } } }),
    prisma.stock.count({ where: { isActive: true, exchange: { in: ["NASDAQ", "NYSE"] } } }),
  ]);
  const [twFilingDate, twPeDate, twPeCoverage, twFundCoverage] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ latest: string | null }>>(`SELECT MAX(period_end)::text AS latest FROM stock_financial_facts WHERE metric='financial.revenue'`).then((r) => r[0]?.latest ?? null),
    prisma.$queryRawUnsafe<Array<{ latest: string | null }>>(`SELECT MAX(period_end)::text AS latest FROM stock_financial_facts WHERE metric='valuation.pe'`).then((r) => r[0]?.latest ?? null),
    pct("valuation.pe", null, ["TWSE", "TPEx", "TPEX"], CURRENT_WITHIN_DAYS.pe, twTotal),
    pct("financial.revenue", null, ["TWSE", "TPEx", "TPEX"], CURRENT_WITHIN_DAYS.fundamentals, twTotal),
  ]);
  const [globalFilingDate, globalPeDate, globalPeCoverage, globalFundCoverage] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ latest: string | null }>>(`SELECT MAX(period_end)::text AS latest FROM stock_financial_facts WHERE metric='revenue' AND source='SEC_EDGAR'`).then((r) => r[0]?.latest ?? null),
    prisma.$queryRawUnsafe<Array<{ latest: string | null }>>(`SELECT MAX(period_end)::text AS latest FROM stock_financial_facts WHERE metric='valuation.pe.ttm.point_in_time'`).then((r) => r[0]?.latest ?? null),
    pct("valuation.pe.ttm.point_in_time", null, ["NASDAQ", "NYSE"], CURRENT_WITHIN_DAYS.pe, usTotal),
    pct("revenue", "SEC_EDGAR", ["NASDAQ", "NYSE"], CURRENT_WITHIN_DAYS.fundamentals, usTotal),
  ]);
  const [twBwibbuSource, globalPeSource, mopsSource, secSource] = await Promise.all([
    runLogFor("CLOUD_TW_FUNDAMENTALS_REFRESH", twPeDate),
    runLogFor("CLOUD_GLOBAL_PE_RECOMPUTE", globalPeDate),
    runLogFor("CLOUD_MOPS_FINANCIAL_INCREMENTAL", twFilingDate),
    runLogFor("CLOUD_SEC_FINANCIAL_INCREMENTAL", globalFilingDate),
  ]);
  const peRunDetails = globalPeSource.last_run_details as { split_adjusted_count?: number; restated_count?: number; computed?: number; insufficient_data?: number } | null;
  const secRunDetails = secSource.last_run_details as { discovered_ciks?: number; deferred_to_next_run?: number; pending_queue_depth?: number } | null;
  // STEP 3/5: live queue depth, not just "as of the last run's details" — a stalled job's queue should
  // still be visible even if no run has completed since it grew.
  const pendingIssuerQueue = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int n FROM production_scheduler_failures WHERE job_id = 'CLOUD_SEC_FINANCIAL_INCREMENTAL' AND resolved = false AND classification = 'OVERFLOW_QUEUED'`,
  ).then((r) => r[0]?.n ?? 0);

  return Response.json(
    {
      generated_at: new Date().toISOString(),
      TW: { latest_financial_filing_date: twFilingDate, latest_pe_date: twPeDate, pe_current_pct: twPeCoverage.pct, fundamentals_current_pct: twFundCoverage.pct },
      GLOBAL: { latest_sec_filing_date: globalFilingDate, latest_pe_recompute_at: globalPeDate, pe_current_pct: globalPeCoverage.pct, fundamentals_current_pct: globalFundCoverage.pct },
      MOPS: {
        last_success: mopsSource.last_success, latest_period: twFilingDate,
        new_facts_last_run: mopsSource.rows_updated, new_filings_24h: mopsSource.rows_updated_24h,
        current_coverage_pct: twFundCoverage.pct,
        cloud_job: "CLOUD_MOPS_FINANCIAL_INCREMENTAL",
      },
      SEC: {
        // Discovery and refresh happen in one bounded invocation this round, so both share one run log.
        last_discovery_success: secSource.last_success, last_refresh_success: secSource.last_success,
        latest_filed_at: globalFilingDate,
        issuers_discovered_last_run: secRunDetails?.discovered_ciks ?? null,
        deferred_last_run: secRunDetails?.deferred_to_next_run ?? null,
        pending_issuer_queue: pendingIssuerQueue,
        issuers_refreshed_24h: secSource.completed_24h, current_coverage_pct: globalFundCoverage.pct,
        cloud_job: "CLOUD_SEC_FINANCIAL_INCREMENTAL",
      },
      EPS_CANONICALIZATION: {
        tested_count: peRunDetails ? (peRunDetails.computed ?? 0) + (peRunDetails.insufficient_data ?? 0) : null,
        resolved_count: peRunDetails?.computed ?? null,
        rejected_count: peRunDetails?.insufficient_data ?? null,
        split_adjusted_count: peRunDetails?.split_adjusted_count ?? null,
        restated_count: peRunDetails?.restated_count ?? null,
      },
      BY_SOURCE: {
        TWSE_OFFICIAL_BWIBBU: { last_success: twBwibbuSource.last_success, last_failure: twBwibbuSource.last_failure, latest_as_of: twBwibbuSource.latest_as_of, rows_updated: twBwibbuSource.rows_updated, cloud_job: "CLOUD_TW_FUNDAMENTALS_REFRESH" },
        SEC_EDGAR_PE_RECOMPUTE: { last_success: globalPeSource.last_success, last_failure: globalPeSource.last_failure, latest_as_of: globalPeSource.latest_as_of, rows_updated: globalPeSource.rows_updated, cloud_job: "CLOUD_GLOBAL_PE_RECOMPUTE" },
        MOPS_TWSE_FINANCIAL: { last_success: mopsSource.last_success, last_failure: mopsSource.last_failure, latest_as_of: mopsSource.latest_as_of, rows_updated: mopsSource.rows_updated, cloud_job: "CLOUD_MOPS_FINANCIAL_INCREMENTAL" },
        SEC_EDGAR: { last_success: secSource.last_success, last_failure: secSource.last_failure, latest_as_of: secSource.latest_as_of, rows_updated: secSource.rows_updated, cloud_job: "CLOUD_SEC_FINANCIAL_INCREMENTAL" },
      },
    },
    { headers },
  );
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
