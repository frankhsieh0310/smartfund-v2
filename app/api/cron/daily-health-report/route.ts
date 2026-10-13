// Daily 08:30 Taipei health check across all six domestic/cloud pipelines this session built or
// touched: market-close-sync, etf-returns-sync, us-fund-nav-sync, sitca-nav-sync, offshore-nav-sync
// (all logged via production_scheduler_runs in THIS database), and tw-data-updater's institutional
// data (also logged here, in the same shared Postgres, since today's fix added run-logging there) and
// stock price data (NOT logged anywhere -- tw-data-updater's price-update.js never wrote to
// production_scheduler_runs; checked via stock_history freshness instead, the only signal available).
//
// Read-only: every check is a SELECT. The only write is the route's own run-log entry (finishRun),
// same existing table every other pipeline already uses -- no new table, no write to any business
// data table. Notification only fires on anomaly (lib/daily-health-report/notify.ts); a clean day
// writes the run log and returns, nothing else.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { checkPipelineRunLog, evaluateFreshness, checkEtfDataSourceGap, type QueryFn } from "@/lib/daily-health-report/checks";
import { notifyAnomaly } from "@/lib/daily-health-report/notify";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "DAILY_HEALTH_REPORT";
const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

// Pipelines logged in THIS database's production_scheduler_runs (smartfund-v2's own crons, plus
// tw-data-updater's institutional-update which shares this same Postgres and started logging here
// as of today's fix).
const RUN_LOG_PIPELINES = [
  "MARKET_CLOSE_SYNC_SHADOW",
  "ETF_RETURNS_SYNC",
  "US_FUND_NAV_SYNC",
  "SITCA_NAV_SYNC",
  "OFFSHORE_NAV_SYNC",
  "INSTITUTIONAL_UPDATE",
];

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const runKey = `daily-health-report:${today}`;

  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "INTERNAL_HEALTH_CHECK", runKey,
    universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "already ran today", runKey });
  }

  const pipelineHealth = await Promise.all(RUN_LOG_PIPELINES.map((j) => checkPipelineRunLog(query, j)));

  // tw-data-updater's stock price pipeline has no run-log signal (its crons never wrote to this
  // table) -- the only available signal is data freshness itself, checked loosely (not a full
  // trading-calendar lookup, documented in checks.ts).
  const stockFreshRow = await prisma.$queryRawUnsafe<Array<{ max_date: string | null }>>(
    `SELECT to_char(max(date), 'YYYY-MM-DD') AS max_date FROM stock_history WHERE stock_id IN (SELECT id FROM stocks WHERE country = 'TW' LIMIT 200)`,
  );
  const stockFreshness = evaluateFreshness("tw_stock_price", stockFreshRow[0]?.max_date ?? null, 4);

  const domesticFundFreshRow = await prisma.$queryRawUnsafe<Array<{ max_date: string | null }>>(
    `SELECT to_char(max(latest_nav_date), 'YYYY-MM-DD') AS max_date FROM funds WHERE COALESCE(data_provider, '') NOT IN ('yahoo', 'SEC')`,
  );
  const domesticFundFreshness = evaluateFreshness("domestic_fund_nav", domesticFundFreshRow[0]?.max_date ?? null, 4);
  const etfDataSourceGap = await checkEtfDataSourceGap(query);

  const anomalies = [
    ...pipelineHealth.filter((p) => p.anomaly).map((p) => ({ type: "PIPELINE", jobId: p.jobId, reasons: p.anomalyReasons })),
    ...[stockFreshness, domesticFundFreshness].filter((f) => f.anomaly).map((f) => ({ type: "FRESHNESS", label: f.label, reason: f.anomalyReason })),
    ...(etfDataSourceGap.anomaly ? [{ type: "ETF_DATA_SOURCE_GAP", newCodes: etfDataSourceGap.newCodes }] : []),
  ];

  let notifyResult = null;
  if (anomalies.length > 0) {
    const lines = [`Daily health report ${today}: ${anomalies.length} anomalies`];
    for (const p of pipelineHealth) if (p.anomaly) lines.push(`- PIPELINE ${p.jobId}: ${p.anomalyReasons.join(", ")}`);
    for (const f of [stockFreshness, domesticFundFreshness]) if (f.anomaly) lines.push(`- FRESHNESS ${f.label}: ${f.anomalyReason}`);
    if (etfDataSourceGap.anomaly) lines.push(`- ETF data_source NULL (new, not yet investigated): ${etfDataSourceGap.newCodes.join(", ")}`);
    if (etfDataSourceGap.knownCodes.length > 0) lines.push(`(known/suspected-delisted, not a new warning: ${etfDataSourceGap.knownCodes.join(", ")})`);
    notifyResult = await notifyAnomaly(lines.join("\n"));
  }

  const status = anomalies.length > 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "INTERNAL_HEALTH_CHECK", startedMs, {
    status, attempted: RUN_LOG_PIPELINES.length + 2, completed: RUN_LOG_PIPELINES.length + 2 - anomalies.length,
    inserted: 0, updated: 0, failed: anomalies.length, retryableFailures: 0, checkpointAfter: null,
    details: {
      date: today, pipeline_health: pipelineHealth, stock_freshness: stockFreshness, domestic_fund_freshness: domesticFundFreshness,
      etf_data_source_gap: etfDataSourceGap, anomaly_count: anomalies.length, anomalies, notify_result: notifyResult,
    },
  });

  return Response.json({ ok: true, job: JOB, runId, status, anomalyCount: anomalies.length, anomalies, etfDataSourceGap, notifyResult });
}
