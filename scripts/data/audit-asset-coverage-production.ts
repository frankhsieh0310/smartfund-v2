/**
 * Read-only production inventory for non-stock asset classes.
 *
 * Run with Railway's production environment so this never relies on a local
 * DATABASE_URL: railway run --no-local -- node --experimental-strip-types ...
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

type DbStat = {
  universe: number | null;
  products: number | null;
  rows: number | null;
  earliest: string | null;
  latest: string | null;
  sources: string;
  provenance: string;
  table: string;
  queryErrors: string[];
};

type AuditRow = DbStat & {
  assetClass: string;
  coverage: string;
  status: "NOT_STARTED" | "SCHEMA_ONLY" | "MASTER_ONLY" | "PARTIAL_HISTORICAL" | "HISTORICAL_READY_WITH_EXCEPTIONS" | "HISTORICAL_COMPLETE" | "DAILY_NOT_STARTED" | "DAILY_ACTIVE" | "MARKET_ACTIVE" | "UNKNOWN";
  rawArchive: string;
  historicalWorker: string;
  checkpoint: string;
  resume: string;
  failureQueue: string;
  validation: string;
  historicalSummary: string;
  dailyWorker: string;
  productionScheduler: string;
  websiteApi: string;
  blocking: string;
};

const prisma = new PrismaClient();
const root = process.cwd();

function num(value: unknown): number {
  return Number(value ?? 0);
}

function iso(value: unknown): string | null {
  if (!value) return null;
  return new Date(String(value)).toISOString().slice(0, 10);
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

async function one<T extends Record<string, unknown>>(sql: string, errors: string[], label: string): Promise<T | null> {
  try {
    const result = await prisma.$queryRawUnsafe<T[]>(sql);
    return result[0] ?? null;
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function scalar(sql: string, errors: string[], label: string): Promise<number | null> {
  const result = await one<{ value: unknown }>(sql, errors, label);
  return result ? num(result.value) : null;
}

async function sourceValues(sql: string, errors: string[], label: string): Promise<string> {
  const result = await one<{ values: string | null }>(sql, errors, label);
  return result?.values ?? "NONE_OR_UNAVAILABLE";
}

async function probeProductionApi(path: string): Promise<{ path: string; status: number | "NETWORK_ERROR" }> {
  try {
    const response = await fetch(`https://smartfund-v2.vercel.app${path}`, { signal: AbortSignal.timeout(20_000) });
    return { path, status: response.status };
  } catch {
    return { path, status: "NETWORK_ERROR" };
  }
}

async function tableStat(options: {
  table: string;
  masterTable: string;
  masterId: string;
  historyTable: string;
  historyForeignKey: string;
  masterWhere?: string;
  sourceSql: string;
  provenance: string;
}): Promise<DbStat> {
  const errors: string[] = [];
  const where = options.masterWhere ? ` WHERE ${options.masterWhere}` : "";
  // Deliberately avoid a large join with COUNT(DISTINCT ...). Production has a
  // statement timeout; each query uses the existing per-product history index.
  const universe = await scalar(`SELECT COUNT(*)::bigint AS value FROM ${options.masterTable} m${where}`, errors, `${options.table} master count`);
  const products = await scalar(
    `SELECT COUNT(*)::bigint AS value FROM ${options.masterTable} m${where} ${options.masterWhere ? "AND" : "WHERE"} EXISTS (SELECT 1 FROM ${options.historyTable} h WHERE h.${options.historyForeignKey} = m.${options.masterId})`,
    errors,
    `${options.table} covered product count`,
  );
  const history = await one<{ rows: unknown; earliest: unknown; latest: unknown }>(
    `SELECT COUNT(*)::bigint AS rows, MIN(h.date) AS earliest, MAX(h.date) AS latest FROM ${options.historyTable} h JOIN ${options.masterTable} m ON m.${options.masterId} = h.${options.historyForeignKey}${where}`,
    errors,
    `${options.table} history aggregate`,
  );
  return {
    universe,
    products,
    rows: history ? num(history.rows) : null,
    earliest: history ? iso(history.earliest) : null,
    latest: history ? iso(history.latest) : null,
    sources: await sourceValues(options.sourceSql, errors, `${options.table} source inventory`),
    provenance: options.provenance,
    table: options.table,
    queryErrors: errors,
  };
}

function coverage(stat: DbStat): string {
  if (stat.universe === null || stat.products === null) return "UNKNOWN";
  if (stat.universe === 0) return "0 / 0";
  return `${stat.products} / ${stat.universe} (${((stat.products / stat.universe) * 100).toFixed(2)}%)`;
}

function inferStatus(stat: DbStat): AuditRow["status"] {
  if (stat.universe === null || stat.products === null || stat.rows === null) return "UNKNOWN";
  if (stat.universe === 0 && stat.rows === 0) return "SCHEMA_ONLY";
  if (stat.universe > 0 && stat.rows === 0) return "MASTER_ONLY";
  if (stat.products === 0) return "NOT_STARTED";
  if (stat.products < stat.universe) return "PARTIAL_HISTORICAL";
  return "HISTORICAL_READY_WITH_EXCEPTIONS";
}

function archiveEvidence(paths: Record<string, boolean>): string {
  return paths.raw ? "Local raw/archive directories exist; production linkage not evidenced" : "No local raw/archive directory found";
}

function rowsToMarkdown(rows: AuditRow[]): string[] {
  const lines = [
    "| Asset Class | Universe / Master Count | Historical Product Count | Historical Row Count | Coverage | Earliest | Latest | Source / Provenance | Current Status | Blocking Issue |",
    "|---|---:|---:|---:|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const source = `${row.sources}; ${row.provenance}`.replaceAll("|", "/");
    lines.push(`| ${row.assetClass} | ${row.universe ?? "UNKNOWN"} | ${row.products ?? "UNKNOWN"} | ${row.rows ?? "UNKNOWN"} | ${row.coverage} | ${row.earliest ?? "UNKNOWN"} | ${row.latest ?? "UNKNOWN"} | ${source} | ${row.status} | ${row.blocking.replaceAll("|", "/")} |`);
  }
  return lines;
}

async function main(): Promise<void> {
  const localPaths = Object.fromEntries(await Promise.all(["debug", "data", "raw"].map(async (name) => [name, await readdir(join(root, name)).then(() => true).catch(() => false)])));
  const dailyConfigText = await readFile(join(root, "config", "production-yahoo-daily-jobs.json"), "utf8").catch(() => "{}");
  const dailyConfig = JSON.parse(dailyConfigText) as { jobs?: Array<{ id: string; exchange: string }> };
  const apiProbes = await Promise.all(["/api/etfs?limit=1", "/api/funds?limit=1", "/api/economic-series?limit=1"].map(probeProductionApi));
  const probeStatus = (kind: string): string => {
    const path = kind === "etf" ? "/api/etfs?limit=1" : kind === "fund" ? "/api/funds?limit=1" : kind === "macro" ? "/api/economic-series?limit=1" : null;
    const probe = apiProbes.find((value) => value.path === path);
    return probe ? `Production HTTP ${probe.status}` : "No matching production API probe";
  };
  const jobs = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT provider, status, COUNT(*)::bigint AS count, MAX(updated_at) AS latest FROM history_jobs GROUP BY provider, status ORDER BY provider, status`).catch((error) => [{ error: error instanceof Error ? error.message : String(error) }]);
  const failures = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT j.provider, q.error_category, COUNT(*)::bigint AS count FROM history_failed_queue q JOIN history_jobs j ON j.id = q.job_id GROUP BY j.provider, q.error_category ORDER BY j.provider, q.error_category`).catch((error) => [{ error: error instanceof Error ? error.message : String(error) }]);

  const [etfTaiwan, etfGlobal, funds, macro, globalIndex, reits, insurance] = await Promise.all([
    tableStat({ table: "etfs + etf_history (Taiwan)", masterTable: "etfs", masterId: "id", historyTable: "etf_history", historyForeignKey: "etf_id", masterWhere: "m.exchange ILIKE '%TW%' OR m.currency = 'TWD'", sourceSql: "SELECT 'UNVERIFIABLE_MASTER_METADATA' AS values", provenance: "etf_history has no per-row source/provider field; master source fields contain symbols/codes rather than normalized provenance" }),
    tableStat({ table: "etfs + etf_history (global)", masterTable: "etfs", masterId: "id", historyTable: "etf_history", historyForeignKey: "etf_id", masterWhere: "NOT (m.exchange ILIKE '%TW%' OR m.currency = 'TWD')", sourceSql: "SELECT 'UNVERIFIABLE_MASTER_METADATA' AS values", provenance: "etf_history has no per-row source/provider field; master source fields contain symbols/codes rather than normalized provenance" }),
    tableStat({ table: "funds + fund_history", masterTable: "funds", masterId: "id", historyTable: "fund_history", historyForeignKey: "fund_id", sourceSql: "SELECT 'UNVERIFIABLE_MASTER_METADATA' AS values", provenance: "fund_history has no per-row source/provider field; master source fields contain codes rather than normalized provenance" }),
    tableStat({ table: "economic_series + economic_values", masterTable: "economic_series", masterId: "id", historyTable: "economic_values", historyForeignKey: "series_id", sourceSql: "SELECT string_agg(DISTINCT provider, ', ') AS values FROM economic_series", provenance: "economic_values includes source_url/source_version/raw_checksum/imported_at" }),
    tableStat({ table: "market_indexes + index_history", masterTable: "market_indexes", masterId: "id", historyTable: "index_history", historyForeignKey: "index_id", sourceSql: "SELECT string_agg(DISTINCT provider, ', ') AS values FROM market_indexes", provenance: "index_history includes provider/provider_symbol/raw_payload_reference/imported_at" }),
    tableStat({ table: "assets + asset_performances (REIT)", masterTable: "assets", masterId: "id", historyTable: "asset_performances", historyForeignKey: "asset_id", masterWhere: "asset_type = 'REIT'", sourceSql: "SELECT string_agg(DISTINCT COALESCE(provider, 'NULL'), ', ') AS values FROM assets WHERE asset_type = 'REIT'", provenance: "asset_performances has no per-row source/provider field" }),
    tableStat({ table: "insurance_products + insurance_history", masterTable: "insurance_products", masterId: "id", historyTable: "insurance_history", historyForeignKey: "product_id", sourceSql: "SELECT 'NOT_MODELED' AS values", provenance: "insurance_history has no per-row source/provider field" }),
  ]);

  const marketErrors: string[] = [];
  const marketTypes = await prisma.$queryRawUnsafe<Array<{ asset_type: string; universe: unknown; products: unknown; rows: unknown; earliest: unknown; latest: unknown; sources: string | null }>>(
    `WITH classified AS (SELECT m.*, CASE WHEN asset_type::text <> 'COMMODITY' THEN asset_type::text WHEN lower(coalesce(symbol, '') || ' ' || coalesce(name, '')) ~ '(gold|silver|platinum|palladium)' THEN 'PRECIOUS_METALS' WHEN lower(coalesce(symbol, '') || ' ' || coalesce(name, '')) ~ '(oil|crude|brent|wti|natural gas|gasoline|heating)' THEN 'OIL_ENERGY' ELSE 'COMMODITY' END AS audited_type FROM market_master m), masters AS (SELECT audited_type AS asset_type, COUNT(*)::bigint AS universe, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM market_history h WHERE h.symbol = m.symbol))::bigint AS products, string_agg(DISTINCT COALESCE(provider, 'NULL'), ', ') AS sources FROM classified m GROUP BY audited_type), histories AS (SELECT m.audited_type AS asset_type, COUNT(h.*)::bigint AS rows, MIN(h.date) AS earliest, MAX(h.date) AS latest FROM classified m LEFT JOIN market_history h ON h.symbol = m.symbol GROUP BY m.audited_type) SELECT masters.asset_type, masters.universe, masters.products, histories.rows, histories.earliest, histories.latest, masters.sources FROM masters JOIN histories USING (asset_type) ORDER BY masters.asset_type`,
  ).catch((error) => { marketErrors.push(error instanceof Error ? error.message : String(error)); return []; });

  const marketLabels: Record<string, string> = {
    BOND: "Bond Indices / Yields",
    COMMODITY: "Commodities (non-energy, non-precious)",
    PRECIOUS_METALS: "Precious Metals / Metal Indices",
    OIL_ENERGY: "Oil / Energy Commodities",
    FOREX: "FX",
    CRYPTO: "Crypto",
    INDEX: "Market Indices (market_master)",
    VOLATILITY: "Volatility / Other Market Indicators",
  };
  const marketRows = marketTypes.map((value): DbStat & { type: string } => ({
    type: value.asset_type,
    universe: num(value.universe), products: num(value.products), rows: num(value.rows), earliest: iso(value.earliest), latest: iso(value.latest), sources: value.sources ?? "NONE_OR_UNAVAILABLE",
    provenance: "market_history has no per-row source/provider field; provider is master-level only", table: "market_master + market_history", queryErrors: [...marketErrors],
  }));

  const rawEvidence = archiveEvidence(localPaths);
  const schedulerEvidence = (label: string) => dailyConfig.jobs?.some((job) => job.id.toLowerCase().includes(label.toLowerCase())) ? "Configured in production-yahoo-daily-jobs.json; no non-stock production execution evidenced" : "Not configured in production-yahoo-daily-jobs.json";
  const workerEvidence = (label: string) => `Scripts found by repository scan: ${label}; no production run-ledger linkage evidenced`;
  const makeRow = (assetClass: string, stat: DbStat, blocking: string, websiteApi: string, dailyLabel: string): AuditRow => ({
    assetClass, ...stat, coverage: coverage(stat), status: inferStatus(stat), rawArchive: rawEvidence,
    historicalWorker: workerEvidence(stat.table), checkpoint: "No dedicated production lifecycle checkpoint evidenced", resume: "No dedicated production resume evidence", failureQueue: "history_failed_queue exists; asset-specific linkage not evidenced", validation: "No production validation record evidenced", historicalSummary: "No production historical summary evidenced", dailyWorker: "Repository script may exist; no production execution evidenced", productionScheduler: schedulerEvidence(dailyLabel), websiteApi: `${websiteApi}; ${probeStatus(dailyLabel)}`, blocking,
  });

  const rows: AuditRow[] = [
    makeRow("Taiwan ETF", etfTaiwan, "No production daily job or ETF lifecycle evidence", "/api/etfs and /api/etfs/[id]/history exist (not production-called by this audit)", "etf"),
    makeRow("US / Global ETF", etfGlobal, "No production daily job or ETF lifecycle evidence", "/api/etfs and /api/etfs/[id]/history exist (not production-called by this audit)", "etf"),
    makeRow("Mutual Funds", funds, "Master-to-history coverage and provenance are incomplete; no production daily job", "/api/funds and /api/funds/[id]/nav exist (not production-called by this audit)", "fund"),
    makeRow("Macro", macro, "No macro provider production scheduler/execution evidence", "/api/economic-series and /api/economic-series/[id]/history exist (not production-called by this audit)", "macro"),
    makeRow("Global Stock Indices", globalIndex, "No index production daily scheduler/execution evidence", "No dedicated market-index API route found in repository scan", "index"),
    makeRow("REITs", reits, "No dedicated REIT historical/daily lifecycle evidence", "No dedicated REIT history API route found in repository scan", "reit"),
    makeRow("Insurance Products (other existing asset class)", insurance, "No source provenance or production lifecycle evidence", "No dedicated insurance history API route found in repository scan", "insurance"),
    ...marketRows.map((stat) => makeRow(marketLabels[stat.type] ?? stat.type, stat, "No non-stock market-data production scheduler/execution evidence", "No dedicated API production verification in this audit", stat.type.toLowerCase())),
  ];

  const mockSignals = await one<{ value: unknown }>(`SELECT COUNT(*)::bigint AS value FROM market_data WHERE lower(COALESCE(symbol, '')) ~ '(sample|mock|test)' OR lower(COALESCE(name, '')) ~ '(sample|mock|test)'`, [], "market_data mock signal");
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "READ_ONLY_PRODUCTION_AUDIT",
    scope: "Non-stock asset classes only; no worker or scheduler was started or changed.",
    rows,
    evidence: { schema: "prisma/schema.prisma", migrations: "prisma/migrations", dailyConfig, historyJobs: jobs, historyFailureQueue: failures, localPaths, mockSignalsInMarketData: mockSignals ? num(mockSignals.value) : null, productionApiProbes: apiProbes },
  };
  const markdown = [
    "# SmartFund Non-Stock Data Asset Coverage Audit",
    "",
    `- Generated (UTC): ${report.generatedAt}`,
    "- Mode: **read-only production audit**. No worker, scheduler, checkpoint, queue, or production data was modified.",
    "- Scope: non-stock asset classes only. A local raw archive is not treated as proof of production ingestion.",
    "",
    "## Coverage summary",
    "",
    ...rowsToMarkdown(rows),
    "",
    "## Cross-validation evidence",
    "",
    `- Prisma schema: \`prisma/schema.prisma\`; migrations include production lifecycle migrations through \`20260729120000_add_provider_symbol_mapping_registry\`.`,
    `- Production daily config: \`${dailyConfig.jobs?.map((job) => job.id).join(", ") || "none"}\`. It contains stock-exchange jobs only; it does not evidence production scheduling for the audited non-stock classes.`,
    `- Historical job ledger rows: \`${json(jobs)}\`.`,
    `- Historical failure queue rows: \`${json(failures)}\`.`,
    `- Local archive directories: \`${json(localPaths)}\`; these are explicitly not production evidence.`,
    `- Mock/sample/test signal in \`market_data\`: \`${mockSignals ? num(mockSignals.value) : "UNKNOWN"}\`. This table is reported as a signal only, not merged into canonical history.`,
    `- Production API probes: \`${json(apiProbes)}\`. A local route's presence is not treated as evidence that the production deployment is serving it.`,
    "",
    "## Provenance limitations",
    "",
    "- `index_history` and `economic_values` retain row-level provenance fields.",
    "- `etf_history`, `fund_history`, `market_history`, `asset_performances`, and `insurance_history` do not retain an equivalent per-row provider/source field in the current schema. Master-level provider fields cannot prove every historical row's origin.",
    "- A query timeout is reported as `UNKNOWN`; it is never converted into a completion claim.",
    "",
    "## Detailed lifecycle evidence",
    "",
    ...rows.flatMap((row) => [
      `### ${row.assetClass}`,
      `- Historical worker: ${row.historicalWorker}`,
      `- Raw archive: ${row.rawArchive}`,
      `- Checkpoint / Resume: ${row.checkpoint} / ${row.resume}`,
      `- Failure queue / Validation / Summary: ${row.failureQueue} / ${row.validation} / ${row.historicalSummary}`,
      `- Daily worker / Scheduler: ${row.dailyWorker} / ${row.productionScheduler}`,
      `- Website API: ${row.websiteApi}`,
      `- Query errors: ${row.queryErrors.length ? row.queryErrors.join("; ") : "none"}`,
      "",
    ]),
  ].join("\n");

  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "data-asset-coverage-audit.md"), `${markdown}\n`, "utf8");
  await writeFile(join(root, "config", "data-asset-coverage-audit.json"), `${json(report)}\n`, "utf8");
  console.log(json({ generatedAt: report.generatedAt, rows: rows.map((row) => ({ assetClass: row.assetClass, coverage: row.coverage, status: row.status, errors: row.queryErrors.length })) }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
