import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

type Market = {
  jobId: string;
  market: string;
  exchanges: string[];
  country: string;
  scheduled: boolean;
};

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

function marketSql(market: Market): { sql: string; values: string[] } {
  const placeholders = market.exchanges.map((_, index) => `$${index + 1}`).join(", ");
  return {
    sql: `SELECT
      COUNT(*)::int AS universe,
      COUNT(*) FILTER (WHERE s.is_active)::int AS active,
      COUNT(*) FILTER (WHERE NOT s.is_active)::int AS inactive,
      COUNT(*) FILTER (WHERE s.history_backfilled_at IS NOT NULL)::int AS historical_stocks,
      MIN(s.history_backfilled_at) AS historical_evidence_started_at,
      MAX(s.latest_date) AS latest
      FROM stocks s
      WHERE s.exchange IN (${placeholders}) AND s.country = $${market.exchanges.length + 1}`,
    values: [...market.exchanges, market.country],
  };
}

async function main(): Promise<void> {
  const detail = process.argv.includes("--detail");
  const config = JSON.parse(await readFile(join(process.cwd(), "config", "production-yahoo-daily-jobs.json"), "utf8")) as { jobs: Array<{ id: string; exchange: string; exchanges?: string[]; country?: string }> };
  const markets: Market[] = [
    ...config.jobs.map((job) => ({ jobId: job.id, market: job.exchange, exchanges: job.exchanges ?? [job.exchange], country: job.country ?? "", scheduled: true })),
    { jobId: "spain-yahoo-daily", market: "Spain", exchanges: ["MCE"], country: "ES", scheduled: false },
  ];
  const marketRows: Array<Record<string, unknown>> = [];
  for (const market of markets) {
    const query = marketSql(market);
    // The session pool has a fixed client ceiling. This audit intentionally
    // serializes market reads so an observability report can never exhaust
    // Production connections or contend with Daily jobs.
    const coverage = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(query.sql, ...query.values);
    const runs = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT status, attempted, completed, failed, latest_trading_date, validation_status, exit_code, started_at, completed_at FROM production_scheduler_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 1", market.jobId);
    const checkpoints = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT last_symbol, processed, succeeded, failed, updated_at FROM production_scheduler_checkpoints WHERE job_id = $1", market.jobId);
    const failures = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT COUNT(*)::int AS open FROM production_scheduler_failures WHERE job_id = $1 AND resolved = false", market.jobId);
    marketRows.push({ ...market, ...coverage[0], lastRun: runs[0] ?? null, checkpoint: checkpoints[0] ?? null, openFailures: failures[0]?.open ?? 0 });
  }
  const financialSummary = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT COUNT(*)::int AS rows, COUNT(DISTINCT stock_id)::int AS stocks, COUNT(DISTINCT metric)::int AS metrics, MIN(period_end) AS earliest, MAX(period_end) AS latest FROM stock_financial_facts");
  const financialFacts = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(detail
    ? "SELECT metric, COUNT(DISTINCT stock_id)::int AS stocks, COUNT(*)::int AS rows, MIN(period_end) AS earliest, MAX(period_end) AS latest, ARRAY_AGG(DISTINCT source) AS sources FROM stock_financial_facts GROUP BY metric ORDER BY metric"
    : "SELECT metric, COUNT(DISTINCT stock_id)::int AS stocks, COUNT(*)::int AS rows, MIN(period_end) AS earliest, MAX(period_end) AS latest, ARRAY_AGG(DISTINCT source) AS sources FROM stock_financial_facts WHERE metric IN ('revenue', 'eps.diluted.quarter', 'eps.diluted.ttm', 'valuation.pe', 'valuation.pe.ttm.point_in_time', 'yahoo.event.cashDividend', 'yahoo.event.splitRatio') GROUP BY metric ORDER BY metric");
  const corporateEventFacts = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT metric, COUNT(DISTINCT stock_id)::int AS stocks, COUNT(*)::int AS rows, MIN(period_end) AS earliest, MAX(period_end) AS latest FROM stock_financial_facts WHERE metric IN ('yahoo.event.cashDividend', 'yahoo.event.splitRatio') GROUP BY metric ORDER BY metric");
  const tables = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%stock%' OR table_name ILIKE '%corporate%' OR table_name ILIKE '%dividend%' OR table_name ILIKE '%split%') ORDER BY table_name");
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), detail, markets: marketRows, financialSummary: financialSummary[0], corporateEventFacts, financialFacts, relevantTables: tables }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
