import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Job = { id: string; market: string; country: string; exchanges: string[]; schedulerEnabled: boolean };
const query = (sql: string, params: unknown[] = []) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;

export async function GET() {
  const registry = JSON.parse(await readFile(join(process.cwd(), "config", "production-yahoo-daily-jobs.json"), "utf8")) as { jobs: Job[] };
  const capability = JSON.parse(await readFile(join(process.cwd(), "config", "yahoo-capability-registry.json"), "utf8"));
  const active = await query(`SELECT country,exchange,count(*)::int target,
    count(*) FILTER (WHERE yahoo_symbol IS NOT NULL AND yahoo_symbol<>'')::int mapped,max(latest_date) db_latest
    FROM stocks WHERE is_active=TRUE GROUP BY country,exchange ORDER BY country,exchange`);
  const jobs = registry.jobs.filter((job) => job.schedulerEnabled);
  const markets = await Promise.all(jobs.map(async (job) => {
    const groups = active.filter((row) => row.country === job.country && job.exchanges.includes(row.exchange));
    const target = groups.reduce((sum, row) => sum + Number(row.target), 0);
    const mapped = groups.reduce((sum, row) => sum + Number(row.mapped), 0);
    const [run] = await query(`SELECT provider_latest_date::text,completed_at,status,validation_details,
      attempted,completed,success_count,no_update_count,permanent_unavailable_count,retryable_failure_count
      FROM production_scheduler_runs WHERE job_id=$1 AND run_type<>'PROVIDER_PROBE'
      ORDER BY started_at DESC LIMIT 1`, [job.id]);
    const sourceLatest = run?.provider_latest_date ?? run?.validation_details?.providerLatestDate ?? null;
    const [coverage] = sourceLatest ? await query(`SELECT count(*) FILTER (WHERE latest_date=$3::date)::int current,
      count(*) FILTER (WHERE latest_date IS NULL OR latest_date<$3::date)::int lagging FROM stocks
      WHERE is_active=TRUE AND country=$1 AND exchange=ANY($2::text[])`, [job.country, job.exchanges, sourceLatest]) : [{ current: 0, lagging: target }];
    const [failures] = sourceLatest ? await query(`SELECT
      count(*) FILTER (WHERE NOT resolved AND classification<>'PERMANENT_UNAVAILABLE')::int failed,
      count(*) FILTER (WHERE NOT resolved AND classification='PERMANENT_UNAVAILABLE')::int no_data
      FROM production_scheduler_failures WHERE job_id=$1 AND target_trade_date=$2::date`, [job.id, sourceLatest]) : [{ failed: 0, no_data: 0 }];
    const current = Number(coverage?.current ?? 0), lagging = Number(coverage?.lagging ?? target);
    const failed = Number(failures?.failed ?? 0), noData = Number(failures?.no_data ?? 0);
    const latest = groups.map((row) => row.db_latest).filter(Boolean).sort().at(-1) ?? null;
    return { asset_type:"STOCK",market:job.market,country:job.country,module:"PRICE",source_latest:sourceLatest,
      db_latest:latest,app_latest:latest,web_latest:latest,target,yahoo_symbol_mapped:mapped,
      fetched:Number(run?.attempted??0),matched:Number(run?.completed??run?.success_count??0),db_on_latest:current,
      lagging,failed,no_data:noData,
      coverage_pct:target?Number(((current+noData)/target*100).toFixed(2)):0,last_sync:run?.completed_at??null,
      status:!sourceLatest?"SOURCE_UNAVAILABLE":failed?"PARTIAL":lagging?"STALE":"CURRENT" };
  }));
  const registered = new Set(jobs.flatMap((job) => job.exchanges.map((exchange) => `${job.country}:${exchange}`)));
  const unregistered = active.filter((row) => !registered.has(`${row.country}:${row.exchange}`)).map((row) => ({
    asset_type:"STOCK",market:row.exchange,country:row.country,module:"PRICE",source_latest:null,db_latest:row.db_latest,
    app_latest:row.db_latest,web_latest:row.db_latest,target:Number(row.target),yahoo_symbol_mapped:Number(row.mapped),fetched:0,matched:0,db_on_latest:0,lagging:Number(row.target),
    failed:0,no_data:0,coverage_pct:0,last_sync:null,status:"NOT_CONNECTED"
  }));
  return Response.json({generated_at:new Date().toISOString(),orchestrator:"scripts/data/production/run-production-cron.ts",
    trigger:"ordinary master scheduler / production cron",capabilities:capability.capabilities,
    market_module_health:[...markets,...unregistered],progress:"/api/yahoo-ingestion/progress"});
}
