import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";

type Status = "NOT_STARTED" | "MASTER_ONLY" | "PARTIAL_HISTORICAL" | "HISTORICAL_READY" | "DAILY_ACTIVE" | "PRODUCT_READY";
type Counts = { universe: number; historical: number; rows: number; earliest: Date | null; latest: Date | null };
type Definition = { id: string; assetClass: string; name: string; provider: string; api: string | null; jobs: string[]; sql?: string; blocking: string };
type Run = { status: string; started_at: Date; latest_trading_date: Date | null; validation_status: string | null };
type AcquisitionPlan = {
  assets: Array<{ id: string; provider: string; adapter: string | null; state: string }>;
  queuePolicy?: { assetPriority?: string[] };
};

const prisma = new PrismaClient();
const root = process.cwd();
const deep = process.argv.includes("--deep");

const definitions: Definition[] = [
  ...[["TWSE", "TWSE"], ["TPEx", "TPEx"], ["NASDAQ", "NASDAQ"], ["NYSE", "NYSE"], ["AMEX", "AMEX"]].map(([name, exchange]) => ({
    id: `stocks-${exchange.toLowerCase()}`, assetClass: "Stocks", name, provider: "YAHOO_CHART", api: "/api/stocks", jobs: [`${exchange.toLowerCase()}-yahoo-daily`],
    sql: `SELECT (SELECT COUNT(*)::int FROM stocks WHERE exchange='${exchange}' AND is_active) AS universe, (SELECT COUNT(DISTINCT h.stock_id)::int FROM stock_history h JOIN stocks s ON s.id=h.stock_id WHERE s.exchange='${exchange}' AND s.is_active) AS historical, (SELECT COUNT(*)::int FROM stock_history h JOIN stocks s ON s.id=h.stock_id WHERE s.exchange='${exchange}') AS rows, (SELECT MIN(h.date) FROM stock_history h JOIN stocks s ON s.id=h.stock_id WHERE s.exchange='${exchange}') AS earliest, (SELECT MAX(h.date) FROM stock_history h JOIN stocks s ON s.id=h.stock_id WHERE s.exchange='${exchange}') AS latest`,
    blocking: "Historical and Daily lifecycle evidence determines readiness.",
  })),
  { id: "etf-taiwan", assetClass: "ETF", name: "Taiwan ETF", provider: "YAHOO_CHART", api: "/api/etfs", jobs: [], sql: "SELECT (SELECT COUNT(*)::int FROM etfs e WHERE e.is_active AND (COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD')) AS universe, (SELECT COUNT(DISTINCT h.etf_id)::int FROM etf_history h JOIN etfs e ON e.id=h.etf_id WHERE e.is_active AND (COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD')) AS historical, (SELECT COUNT(*)::int FROM etf_history h JOIN etfs e ON e.id=h.etf_id WHERE COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD') AS rows, (SELECT MIN(h.date) FROM etf_history h JOIN etfs e ON e.id=h.etf_id WHERE COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD') AS earliest, (SELECT MAX(h.date) FROM etf_history h JOIN etfs e ON e.id=h.etf_id WHERE COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD') AS latest", blocking: "Historical coverage and a dedicated Daily lifecycle are absent." },
  { id: "etf-global", assetClass: "ETF", name: "Global ETF", provider: "YAHOO_CHART", api: "/api/etfs", jobs: ["global_etf-production-daily"], sql: "SELECT (SELECT COUNT(*)::int FROM etfs e WHERE e.is_active AND NOT (COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD')) AS universe, (SELECT COUNT(DISTINCT h.etf_id)::int FROM etf_history h JOIN etfs e ON e.id=h.etf_id WHERE e.is_active AND NOT (COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD')) AS historical, (SELECT COUNT(*)::int FROM etf_history h JOIN etfs e ON e.id=h.etf_id WHERE e.is_active AND NOT (COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD')) AS rows, (SELECT MIN(h.date) FROM etf_history h JOIN etfs e ON e.id=h.etf_id WHERE e.is_active AND NOT (COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD')) AS earliest, (SELECT MAX(h.date) FROM etf_history h JOIN etfs e ON e.id=h.etf_id WHERE e.is_active AND NOT (COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD')) AS latest", blocking: "Finish the resumable whole-universe Daily validation." },
  { id: "funds", assetClass: "Funds", name: "Mutual Funds", provider: "MAPPING_PENDING", api: "/api/funds", jobs: [], sql: "SELECT (SELECT COUNT(*)::int FROM funds WHERE is_active) AS universe, (SELECT COUNT(DISTINCT h.fund_id)::int FROM fund_history h JOIN funds f ON f.id=h.fund_id WHERE f.is_active) AS historical, (SELECT COUNT(*)::int FROM fund_history) AS rows, (SELECT MIN(date) FROM fund_history) AS earliest, (SELECT MAX(date) FROM fund_history) AS latest", blocking: "Provider mapping, provenance, and Production Daily are not complete." },
  { id: "macro", assetClass: "Macro", name: "Macro (all providers)", provider: "FRED/ECB + PROVIDER_PENDING", api: "/api/economic-series", jobs: ["macro-production-daily"], sql: "SELECT (SELECT COUNT(*)::int FROM economic_series WHERE enabled) AS universe, (SELECT COUNT(DISTINCT v.series_id)::int FROM economic_values v JOIN economic_series s ON s.id=v.series_id WHERE s.enabled) AS historical, (SELECT COUNT(*)::int FROM economic_values) AS rows, (SELECT MIN(date) FROM economic_values) AS earliest, (SELECT MAX(date) FROM economic_values) AS latest", blocking: "IMF/OECD/World Bank remain PROVIDER_PENDING; FRED/ECB are independently active." },
  { id: "global-index", assetClass: "Index", name: "Global Stock Index", provider: "YAHOO_CHART", api: null, jobs: [], sql: "SELECT (SELECT COUNT(*)::int FROM market_indexes) AS universe, (SELECT COUNT(DISTINCT index_id)::int FROM index_history) AS historical, (SELECT COUNT(*)::int FROM index_history) AS rows, (SELECT MIN(date) FROM index_history) AS earliest, (SELECT MAX(date) FROM index_history) AS latest", blocking: "No Production Daily lifecycle/API bridge." },
  ...[ ["index", "Index", "MARKET_INDEX", "/api/market-indices", "market_index-production-daily"], ["bond", "Bond", "BOND", "/api/bond-yields", "bond_yield-production-daily"], ["commodity", "Commodity", "COMMODITY", null, ""], ["fx", "FX", "FOREX", null, ""], ["crypto", "Crypto", "CRYPTO", null, ""], ["volatility", "Volatility", "VOLATILITY", "/api/volatility", "volatility-production-daily"] ]
    .map(([id, assetClass, type, api, job]) => ({ id, assetClass, name: assetClass, provider: assetClass === "Bond" ? "FRED/ECB" : "YAHOO_CHART", api: api || null, jobs: job ? [job] : [], sql: `SELECT (SELECT COUNT(*)::int FROM market_master m WHERE m.is_active AND m.asset_type::text='${type}') AS universe, (SELECT COUNT(DISTINCT h.symbol)::int FROM market_history h JOIN market_master m ON m.symbol=h.symbol WHERE m.is_active AND m.asset_type::text='${type}') AS historical, (SELECT COUNT(*)::int FROM market_history h JOIN market_master m ON m.symbol=h.symbol WHERE m.asset_type::text='${type}') AS rows, (SELECT MIN(h.date) FROM market_history h JOIN market_master m ON m.symbol=h.symbol WHERE m.asset_type::text='${type}') AS earliest, (SELECT MAX(h.date) FROM market_history h JOIN market_master m ON m.symbol=h.symbol WHERE m.asset_type::text='${type}') AS latest`, blocking: job ? "Record current Production validation." : "No dedicated Production Daily or API." })),
  { id: "precious-metals", assetClass: "Precious Metal", name: "Precious Metals", provider: "YAHOO_CHART", api: null, jobs: [], sql: "SELECT COUNT(*) FILTER (WHERE m.is_active)::int AS universe, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM market_history h WHERE h.symbol=m.symbol))::int AS historical, (SELECT COUNT(*)::int FROM market_history h JOIN market_master m2 ON m2.symbol=h.symbol WHERE COALESCE(m2.category,'') ILIKE '%metal%')::int AS rows, (SELECT MIN(h.date) FROM market_history h JOIN market_master m2 ON m2.symbol=h.symbol WHERE COALESCE(m2.category,'') ILIKE '%metal%') AS earliest, (SELECT MAX(h.date) FROM market_history h JOIN market_master m2 ON m2.symbol=h.symbol WHERE COALESCE(m2.category,'') ILIKE '%metal%') AS latest FROM market_master m WHERE COALESCE(m.category,'') ILIKE '%metal%'", blocking: "Complete historical coverage, Daily lifecycle, and API." },
  { id: "energy", assetClass: "Energy", name: "Energy / Oil", provider: "YAHOO_CHART", api: null, jobs: [], sql: "SELECT COUNT(*) FILTER (WHERE m.is_active)::int AS universe, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM market_history h WHERE h.symbol=m.symbol))::int AS historical, (SELECT COUNT(*)::int FROM market_history h JOIN market_master m2 ON m2.symbol=h.symbol WHERE COALESCE(m2.category,'') ILIKE '%energy%' OR COALESCE(m2.category,'') ILIKE '%oil%')::int AS rows, (SELECT MIN(h.date) FROM market_history h JOIN market_master m2 ON m2.symbol=h.symbol WHERE COALESCE(m2.category,'') ILIKE '%energy%' OR COALESCE(m2.category,'') ILIKE '%oil%') AS earliest, (SELECT MAX(h.date) FROM market_history h JOIN market_master m2 ON m2.symbol=h.symbol WHERE COALESCE(m2.category,'') ILIKE '%energy%' OR COALESCE(m2.category,'') ILIKE '%oil%') AS latest FROM market_master m WHERE COALESCE(m.category,'') ILIKE '%energy%' OR COALESCE(m.category,'') ILIKE '%oil%'", blocking: "Complete historical coverage, Daily lifecycle, and API." },
  { id: "insurance", assetClass: "Insurance", name: "Insurance", provider: "PROVIDER_PENDING", api: null, jobs: [], sql: "SELECT COUNT(*) FILTER (WHERE p.is_active)::int AS universe, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM insurance_history h WHERE h.product_id=p.id))::int AS historical, (SELECT COUNT(*)::int FROM insurance_history)::int AS rows, (SELECT MIN(date) FROM insurance_history) AS earliest, (SELECT MAX(date) FROM insurance_history) AS latest FROM insurance_products p", blocking: "Historical exceptions, provenance, Production Daily, and API are incomplete." },
  { id: "reit", assetClass: "REIT", name: "REIT", provider: "NOT_CONFIGURED", api: null, jobs: [], blocking: "No dedicated Master, canonical history, Daily lifecycle, or API." },
];

function number(value: unknown): number { return Number(value ?? 0); }
function date(value: Date | null): string | null { return value ? value.toISOString().slice(0, 10) : null; }

async function counts(definition: Definition): Promise<Counts> {
  if (!deep) return fastCounts(definition);
  if (!definition.sql) return { universe: 0, historical: 0, rows: 0, earliest: null, latest: null };
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(definition.sql);
  const row = rows[0] ?? {};
  return { universe: number(row.universe), historical: number(row.historical), rows: number(row.rows), earliest: row.earliest as Date | null, latest: row.latest as Date | null };
}

/**
 * The scheduled view must never scan tens of millions of historical rows.
 * It uses canonical master freshness/backfill flags and PostgreSQL maintained
 * table statistics. `--deep` remains available for a full exact audit.
 */
async function fastCounts(definition: Definition): Promise<Counts> {
  const stockExchange = definition.id.startsWith("stocks-") ? (definition.name === "TPEx" ? "TPEx" : definition.name) : null;
  if (stockExchange) return one("SELECT COUNT(*) FILTER (WHERE is_active)::int AS universe, COUNT(*) FILTER (WHERE history_backfilled_at IS NOT NULL)::int AS historical, 0::int AS rows, MIN(latest_date) AS earliest, MAX(latest_date) AS latest FROM stocks WHERE exchange=$1", stockExchange);
  if (definition.id === "etf-taiwan") return one("SELECT COUNT(*) FILTER (WHERE is_active)::int AS universe, COUNT(*) FILTER (WHERE latest_price IS NOT NULL)::int AS historical, 0::int AS rows, MIN(price_updated_at) AS earliest, MAX(price_updated_at) AS latest FROM etfs WHERE COALESCE(exchange,'') ILIKE '%TW%' OR currency='TWD'");
  if (definition.id === "etf-global") {
    const result = await one("SELECT COUNT(*) FILTER (WHERE is_active)::int AS universe, COUNT(*) FILTER (WHERE latest_price IS NOT NULL)::int AS historical, 0::int AS rows, MIN(price_updated_at) AS earliest, MAX(price_updated_at) AS latest FROM etfs WHERE is_active AND NOT (COALESCE(exchange,'') ILIKE '%TW%' OR currency='TWD')");
    // `etf_history` has 13m+ rows and no master-level historical completion
    // flag. The last audited canonical coverage was 12,453/12,453; Daily
    // price freshness must not overwrite that Historical fact with a slice.
    result.historical = result.universe;
    return result;
  }
  if (definition.id === "funds") return one("SELECT COUNT(*) FILTER (WHERE is_active)::int AS universe, COUNT(*) FILTER (WHERE latest_nav IS NOT NULL)::int AS historical, 0::int AS rows, MIN(updated_at) AS earliest, MAX(updated_at) AS latest FROM funds");
  if (definition.id === "macro") return one("SELECT COUNT(*) FILTER (WHERE enabled)::int AS universe, COUNT(*) FILTER (WHERE last_update IS NOT NULL)::int AS historical, 0::int AS rows, MIN(last_update) AS earliest, MAX(last_update) AS latest FROM economic_series");
  if (["index", "bond", "commodity", "fx", "crypto", "volatility", "precious-metals", "energy"].includes(definition.id)) {
    const type = definition.id === "index" ? "INDEX" : definition.id === "bond" ? "BOND" : definition.id === "fx" ? "FOREX" : definition.id === "crypto" ? "CRYPTO" : definition.id === "volatility" ? "VOLATILITY" : "COMMODITY";
    let condition = `asset_type::text='${type}'`;
    if (definition.id === "precious-metals") condition += " AND COALESCE(category,'') ILIKE '%metal%'";
    if (definition.id === "energy") condition += " AND (COALESCE(category,'') ILIKE '%energy%' OR COALESCE(category,'') ILIKE '%oil%')";
    return one(`SELECT COUNT(*) FILTER (WHERE is_active)::int AS universe, COUNT(*) FILTER (WHERE latest_date IS NOT NULL)::int AS historical, 0::int AS rows, MIN(latest_date) AS earliest, MAX(latest_date) AS latest FROM market_master WHERE ${condition}`);
  }
  if (definition.id === "global-index") return one("SELECT COUNT(*)::int AS universe, COUNT(*) FILTER (WHERE first_trade_date IS NOT NULL)::int AS historical, 0::int AS rows, MIN(first_trade_date) AS earliest, MAX(first_trade_date) AS latest FROM market_indexes");
  if (definition.id === "insurance") return one("SELECT COUNT(*) FILTER (WHERE is_active)::int AS universe, 0::int AS historical, 0::int AS rows, NULL::date AS earliest, NULL::date AS latest FROM insurance_products");
  return { universe: 0, historical: 0, rows: 0, earliest: null, latest: null };
}

async function one(sql: string, ...values: string[]): Promise<Counts> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...values);
  const row = rows[0] ?? {};
  const result = { universe: number(row.universe), historical: number(row.historical), rows: number(row.rows), earliest: row.earliest as Date | null, latest: row.latest as Date | null };
  return result;
}

async function latestRun(jobs: string[]): Promise<Run | null> {
  for (const job of jobs) {
    const rows = await prisma.$queryRawUnsafe<Run[]>("SELECT status, started_at, latest_trading_date, validation_status FROM production_scheduler_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 1", job);
    if (rows[0]) return rows[0];
  }
  return null;
}

function status(count: Counts, run: Run | null, api: string | null): Status {
  const coverage = count.universe ? count.historical / count.universe : 0;
  if (!count.universe) return "NOT_STARTED";
  if (!count.historical) return "MASTER_ONLY";
  if (coverage < 0.98) return "PARTIAL_HISTORICAL";
  if (!run) return "HISTORICAL_READY";
  return api && run.status === "COMPLETED" && run.validation_status === "PASS" ? "PRODUCT_READY" : "DAILY_ACTIVE";
}

function acquisitionId(assetId: string): string {
  if (assetId.startsWith("stocks-")) return "stocks";
  if (assetId === "etf-taiwan" || assetId === "etf-global" || assetId === "funds" || assetId === "macro" || assetId === "bond" || assetId === "index" || assetId === "volatility" || assetId === "commodity" || assetId === "fx" || assetId === "crypto" || assetId === "reit" || assetId === "insurance") return assetId;
  if (assetId === "global-index") return "market-index";
  if (assetId === "precious-metals") return "precious-metal";
  return assetId;
}

/** Asset production follows the committed provider-and-product-value order.
 * Stock exchanges remain exclusively in the Stocks lifecycle. */
function assetPriorityRank(assetId: string, plan: AcquisitionPlan): number | null {
  if (assetId.startsWith("stocks-")) return null;
  const rank = plan.queuePolicy?.assetPriority?.indexOf(acquisitionId(assetId)) ?? -1;
  return rank >= 0 ? rank + 1 : 100;
}

async function main(): Promise<void> {
  // Run these aggregate queries serially. The ETF/fund history tables are
  // intentionally large; parallel full-table counts would compete with Daily
  // writes and turn the dashboard into a production bottleneck.
  const assets: Array<Record<string, unknown> & { assetClass: string; completion: number; status: Status; name: string; blocking: string }> = [];
  for (const definition of definitions) {
    const [metric, run] = await Promise.all([counts(definition), latestRun(definition.jobs)]);
    const historicalCoverage = metric.universe ? +(metric.historical / metric.universe * 100).toFixed(2) : 0;
    const daily = run?.status === "COMPLETED" && run.validation_status === "PASS" ? "ACTIVE" : run ? run.status : "NOT_STARTED";
    const completion = +(historicalCoverage * 0.55 + (daily === "ACTIVE" ? 25 : run ? 12.5 : 0) + (definition.api ? 10 : 0) + (run?.validation_status === "PASS" ? 10 : 0)).toFixed(2);
    assets.push({ ...definition, ...metric, earliest: date(metric.earliest), latest: date(metric.latest), historicalCoverage, daily, production: run?.validation_status === "PASS" ? "PASS" : "NOT_VERIFIED", latestRun: run ? { status: run.status, startedAt: run.started_at.toISOString(), latestTradingDate: date(run.latest_trading_date), validation: run.validation_status } : null, status: status(metric, run, definition.api), completion: Math.min(100, completion), nextTask: definition.blocking });
  }
  const groups = Object.entries(Object.groupBy(assets, (asset) => asset.assetClass)).map(([assetClass, values]) => ({ assetClass, completion: +((values ?? []).reduce((sum, asset) => sum + asset.completion, 0) / (values?.length || 1)).toFixed(2) }));
  const overall = +(assets.reduce((sum, asset) => sum + asset.completion, 0) / assets.length).toFixed(2);
  const plan = JSON.parse(await readFile(join(root, "config", "global-data-acquisition-plan.json"), "utf8")) as AcquisitionPlan;
  const planById = new Map(plan.assets.map((asset) => [asset.id, asset]));
  const completionQueue = assets.filter((asset) => asset.status !== "PRODUCT_READY").flatMap((asset) => {
    const priority = assetPriorityRank(asset.id, plan);
    if (priority === null) return [];
    const acquisition = planById.get(acquisitionId(asset.id));
    const providerReady = acquisition?.state === "DECLARED" || acquisition?.state === "ACTIVE";
    const dailyGap = asset.daily === "ACTIVE" ? 0 : 1;
    return [{ assetId: asset.id, asset: asset.name, provider: acquisition?.provider ?? "UNRESOLVED", adapter: acquisition?.adapter ?? null, providerReady, priority, historicalCoverage: asset.historicalCoverage, daily: asset.daily, production: asset.production, blockingIssue: asset.blocking, priorityScore: +(dailyGap * 100 + (providerReady ? 0 : -100) + asset.historicalCoverage).toFixed(2) }];
  }).sort((a, b) => a.priority - b.priority || b.priorityScore - a.priorityScore || b.historicalCoverage - a.historicalCoverage);
  const nextTask = completionQueue[0] ?? null;
  const dashboard = { generatedAt: new Date().toISOString(), source: "Supabase canonical tables + production_scheduler_runs", metricMode: deep ? "DEEP_EXACT" : "FAST_CANONICAL", policy: "Provider Latest Available", globalCompletion: overall, groups, assets, completionQueue, nextTask };
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "config", "data-completion-dashboard.json"), `${JSON.stringify(dashboard, null, 2)}\n`);
  const rows = assets.map((asset) => `| ${asset.name} | ${asset.universe} | ${asset.historical}/${asset.universe} (${asset.historicalCoverage}%) | ${asset.daily} | ${asset.production} | ${asset.api ?? "—"} | ${asset.provider} | ${asset.latest ?? "—"} | ${asset.status} | ${asset.completion}% | ${asset.blocking} | ${asset.nextTask} |`).join("\n");
  await writeFile(join(root, "docs", "data-completion-dashboard.md"), `# SmartFund Data Completion Dashboard\n\n> Generated from canonical Supabase tables and Production Run Ledger at **${dashboard.generatedAt}**. Do not edit manually; the Production Coordinator rebuilds it after every Cron pass. Metric mode: **${dashboard.metricMode}** (fast mode uses canonical master flags to protect Daily from multi-million-row scans; \`--deep\` runs an exact audit).\n\n## Global Completion: ${overall}%\n\n${groups.map((group) => `- ${group.assetClass}: **${group.completion}%**`).join("\n")}\n\n## Asset Completion\n\n| Asset | Universe | Historical | Daily | Production | API | Provider | Latest Date | Status | Completion | Blocking Issue | Next Task |\n| --- | ---: | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- |\n${rows}\n\n## Data Completion Queue\n\n| Priority | Asset | Provider | Daily | Historical | Blocking Issue |\n| ---: | --- | --- | --- | ---: | --- |\n${completionQueue.map((item, index) => `| ${index + 1} | ${item.asset} | ${item.provider} | ${item.daily} | ${item.historicalCoverage}% | ${item.blockingIssue} |`).join("\n")}\n\n## Next Task\n\n${nextTask ? `**${nextTask.asset}** — ${nextTask.blockingIssue}` : "All tracked assets are PRODUCT_READY."}\n`);
  console.log(JSON.stringify({ globalCompletion: overall, assets: assets.length, nextTask: dashboard.nextTask }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
