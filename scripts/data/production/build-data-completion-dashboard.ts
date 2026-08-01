import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { PrismaClient } from "@prisma/client";

type NullableNumber = number | null;
type ProductionState = "PRODUCTION" | "PARTIAL_PRODUCTION" | "DATA_ONLY" | "PROTOTYPE" | "NOT_STARTED" | "UNKNOWN";
type AuditSummary = {
  category: string;
  universe: number;
  historicalExpected: number;
  historicalCompleted: NullableNumber;
  historicalRows: NullableNumber;
  incrementalExpected: number;
  incrementalCompleted: NullableNumber;
  earliest: string | null;
  latest: string | null;
};
type AuditRow = {
  category: string;
  subcategory: string;
  universeCount: NullableNumber;
  mappedCount: NullableNumber;
  historicalCompletedCount: NullableNumber;
  historicalRowCount: NullableNumber;
  earliestDatabaseDate: string | null;
  latestProviderDate: string | null;
  latestDatabaseDate: string | null;
  incrementalExpectedCount: NullableNumber;
  incrementalAttempted: NullableNumber;
  incrementalCompleted: NullableNumber;
  incrementalFailed: NullableNumber;
  validationStatus: string;
  productionStatus: string;
  currentRunStatus: string;
  schedulerEnabled: boolean;
  schedulerRule: string;
  details?: Record<string, unknown>;
};
type Audit = {
  runId: string;
  completedAt: string;
  rows: AuditRow[];
  categorySummary: AuditSummary[];
  tableCounts?: { end?: Record<string, number> };
};
type RoadmapAsset = { order: number; id: string; name: string; requiredLayers: string[] };
type Roadmap = { version: string; completionPolicy: string; assets: RoadmapAsset[] };
type Run = {
  job_id: string;
  run_type: string;
  status: string;
  started_at: Date;
  attempted: NullableNumber;
  completed: NullableNumber;
  failed: NullableNumber;
  provider_latest_date: Date | null;
  latest_trading_date: Date | null;
  validation_status: string | null;
};
type Layer = {
  id: string;
  layer: string;
  universe: NullableNumber;
  completed: NullableNumber;
  coveragePercent: NullableNumber;
  rows: NullableNumber;
  earliestDate: string | null;
  latestDate: string | null;
  production: ProductionState;
  evidence: string;
  missing: string[];
};
type AssetLayers = {
  order: number;
  id: string;
  asset: string;
  currentUniverse: number;
  runningStatus: string;
  layers: Layer[];
};

const root = process.cwd();
const baselineOnly = process.argv.includes("--baseline-only");
const prisma = new PrismaClient();

const percentage = (completed: NullableNumber, universe: NullableNumber): NullableNumber =>
  completed === null || universe === null || universe <= 0 ? null : +Math.min(100, Math.max(0, completed / universe * 100)).toFixed(4);
const maxDate = (...values: Array<string | null | undefined>): string | null =>
  values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
const layer = (input: Omit<Layer, "coveragePercent"> & { coveragePercent?: NullableNumber }): Layer => ({
  ...input,
  coveragePercent: input.coveragePercent === undefined ? percentage(input.completed, input.universe) : input.coveragePercent,
});

async function latestAudit(): Promise<{ file: string; audit: Audit }> {
  const base = join(root, "debug", "global-data-audit");
  const directories = (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const directory of directories) {
    const file = join(base, directory, "global-data-status.json");
    try {
      return { file, audit: JSON.parse(await readFile(file, "utf8")) as Audit };
    } catch {
      // Ignore incomplete audit directories. The latest completed artifact remains authoritative.
    }
  }
  throw new Error("No completed Global Data Audit artifact was found");
}

async function recentRuns(): Promise<{ runs: Run[]; error: string | null }> {
  if (baselineOnly) return { runs: [], error: null };
  try {
    const runs = await prisma.$queryRawUnsafe<Run[]>(
      "SELECT job_id,run_type,status,started_at,attempted,completed,failed,provider_latest_date,latest_trading_date,validation_status FROM production_scheduler_runs WHERE started_at>=NOW()-INTERVAL '45 days' ORDER BY started_at DESC",
    );
    return { runs, error: null };
  } catch (error) {
    return { runs: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function latestPrimaryByJob(runs: Run[]): Map<string, Run> {
  const result = new Map<string, Run>();
  for (const run of runs) {
    if (run.run_type === "PRIMARY" && !result.has(run.job_id)) result.set(run.job_id, run);
  }
  return result;
}

function mergeRun(row: AuditRow, run: Run | undefined, baselineCompletedAt: string): AuditRow {
  if (!run || run.started_at.toISOString() <= baselineCompletedAt) return row;
  return {
    ...row,
    incrementalAttempted: run.attempted,
    incrementalCompleted: run.completed,
    incrementalFailed: run.failed,
    latestProviderDate: run.provider_latest_date?.toISOString().slice(0, 10) ?? row.latestProviderDate,
    latestDatabaseDate: run.latest_trading_date?.toISOString().slice(0, 10) ?? row.latestDatabaseDate,
    validationStatus: run.validation_status ?? row.validationStatus,
    currentRunStatus: run.status,
  };
}

function aggregateStockRows(rows: AuditRow[]) {
  return rows.reduce((result, row) => ({
    universe: result.universe + Number(row.universeCount ?? 0),
    completed: result.completed + Number(row.incrementalCompleted ?? 0),
    latest: maxDate(result.latest, row.latestProviderDate, row.latestDatabaseDate),
    validationPass: result.validationPass + (row.validationStatus === "PASS" ? 1 : 0),
    schedulers: result.schedulers + (row.schedulerEnabled ? 1 : 0),
    running: result.running || ["IN_PROGRESS", "RUNNING"].includes(row.currentRunStatus),
  }), { universe: 0, completed: 0, latest: null as string | null, validationPass: 0, schedulers: 0, running: false });
}

function missingRecord(asset: AssetLayers, item: Layer) {
  return {
    order: asset.order,
    asset: asset.asset,
    layer: item.layer,
    universe: item.universe,
    completed: item.completed,
    coveragePercent: item.coveragePercent,
    production: item.production,
    missing: item.missing,
    evidence: item.evidence,
  };
}

async function main(): Promise<void> {
  const [{ file: auditFile, audit }, roadmap, refresh] = await Promise.all([
    latestAudit(),
    readFile(join(root, "config", "global-asset-production-roadmap.json"), "utf8").then((value) => JSON.parse(value) as Roadmap),
    recentRuns(),
  ]);
  const summaries = new Map(audit.categorySummary.map((item) => [item.category, item]));
  const summary = (category: string): AuditSummary => {
    const value = summaries.get(category);
    if (!value) throw new Error(`Audit baseline is missing category: ${category}`);
    return value;
  };
  const required = (id: string): RoadmapAsset => {
    const value = roadmap.assets.find((item) => item.id === id);
    if (!value) throw new Error(`Roadmap is missing asset: ${id}`);
    return value;
  };
  const latestRuns = latestPrimaryByJob(refresh.runs);

  const stockSummary = summary("Global Stocks");
  const financialSummary = summary("Financial Statements");
  const corporateSummary = summary("Corporate Actions");
  const derivedSummary = summary("Derived Metrics");
  const stockRows = audit.rows.filter((row) => row.category === "Global Stocks").map((row) => {
    const job = `${row.subcategory.toLowerCase().replaceAll(" ", "-")}-yahoo-daily`;
    return mergeRun(row, latestRuns.get(job), audit.completedAt);
  });
  const stockLive = aggregateStockRows(stockRows);
  const stockPriceRows = audit.tableCounts?.end?.stock_history ?? stockSummary.historicalRows;
  const stock = required("stocks");
  const stockLayers: AssetLayers = {
    order: stock.order,
    id: stock.id,
    asset: stock.name,
    currentUniverse: stockSummary.universe,
    runningStatus: stockLive.running ? "RUNNING" : "IDLE",
    layers: [
      layer({ id: "universe", layer: "Universe", universe: stockSummary.universe, completed: stockSummary.universe, rows: stockSummary.universe, earliestDate: null, latestDate: audit.completedAt.slice(0, 10), production: "PRODUCTION", evidence: `${stockSummary.universe.toLocaleString()} registered stocks`, missing: ["Official identifier mapping is incomplete for non-US/non-Taiwan markets"] }),
      layer({ id: "historical_price", layer: "Historical Price", universe: stockSummary.historicalExpected, completed: stockSummary.historicalCompleted, rows: stockPriceRows, earliestDate: stockSummary.earliest, latestDate: stockSummary.latest, production: "PARTIAL_PRODUCTION", evidence: `${stockSummary.historicalCompleted ?? "UNKNOWN"}/${stockSummary.historicalExpected} stocks`, missing: [`${stockSummary.historicalExpected - Number(stockSummary.historicalCompleted ?? 0)} stocks lack completed historical-price status`, "Exact earliest date timed out in the completed audit"] }),
      layer({ id: "daily_price", layer: "Daily Price", universe: stockLive.universe, completed: stockLive.completed, rows: null, earliestDate: null, latestDate: stockLive.latest, production: "PARTIAL_PRODUCTION", evidence: `${stockLive.completed}/${stockLive.universe} stocks in latest per-market runs`, missing: [`${stockLive.universe - stockLive.completed} stocks were not completed in their latest market run`] }),
      layer({ id: "financial_statements", layer: "Financial Statements", universe: stockSummary.universe, completed: financialSummary.historicalCompleted, coveragePercent: null, rows: audit.tableCounts?.end?.stock_financial_facts ?? financialSummary.historicalRows, earliestDate: financialSummary.earliest, latestDate: financialSummary.latest, production: "DATA_ONLY", evidence: "3,848,211 fact rows exist, but per-stock coverage query exceeded the production statement timeout", missing: ["Revenue coverage", "EPS coverage", "Cash coverage", "Debt coverage", "Assets/Liabilities/Equity coverage", "Cash-flow coverage", "Incremental filing scheduler", "Production validation"] }),
      layer({ id: "corporate_actions", layer: "Corporate Actions", universe: stockSummary.universe, completed: corporateSummary.historicalCompleted, rows: corporateSummary.historicalRows, earliestDate: corporateSummary.earliest, latestDate: corporateSummary.latest, production: "NOT_STARTED", evidence: "No canonical stock corporate-action production ledger", missing: ["Dividend", "Split/Reverse Split", "Rights Issue", "Bonus Share", "Capital Reduction", "Ticker/Company Name Change", "Listing/Delisting"] }),
      layer({ id: "derived_metrics", layer: "Derived Metrics", universe: derivedSummary.historicalExpected, completed: derivedSummary.historicalCompleted, rows: derivedSummary.historicalRows, earliestDate: derivedSummary.earliest, latestDate: derivedSummary.latest, production: "PROTOTYPE", evidence: `${derivedSummary.historicalCompleted ?? 0}/${derivedSummary.historicalExpected}; lower-bound financial-ratio evidence`, missing: ["Market Cap", "Enterprise Value", "PE/PB/PS", "Dividend Yield", "ROE/ROA/ROIC", "Margins", "Debt Ratios", "EV/EBITDA", "Point-in-time validation", "Incremental calculation"] }),
      layer({ id: "validation", layer: "Validation", universe: stockRows.length, completed: stockLive.validationPass, rows: stockLive.validationPass, earliestDate: null, latestDate: stockLive.latest, production: "PARTIAL_PRODUCTION", evidence: `${stockLive.validationPass}/${stockRows.length} market latest runs validated PASS`, missing: stockRows.filter((row) => row.validationStatus !== "PASS").map((row) => `${row.subcategory}: ${row.validationStatus}`) }),
      layer({ id: "scheduler", layer: "Scheduler", universe: stockRows.length, completed: stockLive.schedulers, rows: stockLive.schedulers, earliestDate: null, latestDate: audit.completedAt.slice(0, 10), production: "PARTIAL_PRODUCTION", evidence: `${stockLive.schedulers}/${stockRows.length} stock markets scheduler-enabled`, missing: stockRows.filter((row) => !row.schedulerEnabled).map((row) => row.subcategory) }),
    ],
  };

  const etfSummary = summary("ETF");
  const etfRows = audit.rows.filter((row) => row.category === "ETF" && row.subcategory !== "Global ETF Production Daily Lifecycle");
  const etfLifecycleBase = audit.rows.find((row) => row.category === "ETF" && row.subcategory === "Global ETF Production Daily Lifecycle");
  const etfLifecycle = etfLifecycleBase ? mergeRun(etfLifecycleBase, latestRuns.get("global_etf-production-daily"), audit.completedAt) : null;
  const etfNavRows = etfRows.reduce((sum, row) => sum + Number((row.details?.navRows as number | undefined) ?? 0), 0);
  const etf = required("etf");
  const etfLayers: AssetLayers = {
    order: etf.order,
    id: etf.id,
    asset: etf.name,
    currentUniverse: etfSummary.universe,
    runningStatus: etfLifecycle?.currentRunStatus ?? "IDLE",
    layers: [
      layer({ id: "universe", layer: "Universe", universe: etfSummary.universe, completed: etfSummary.universe, rows: etfSummary.universe, earliestDate: null, latestDate: audit.completedAt.slice(0, 10), production: "PRODUCTION", evidence: `${etfSummary.universe} ETFs`, missing: [] }),
      layer({ id: "historical_price", layer: "Historical Price", universe: etfSummary.historicalExpected, completed: etfSummary.historicalCompleted, rows: etfSummary.historicalRows, earliestDate: etfSummary.earliest, latestDate: etfSummary.latest, production: "PARTIAL_PRODUCTION", evidence: `${etfSummary.historicalCompleted}/${etfSummary.historicalExpected}`, missing: [`${etfSummary.historicalExpected - Number(etfSummary.historicalCompleted ?? 0)} ETFs have no completed history`] }),
      layer({ id: "daily_price", layer: "Daily Price", universe: etfLifecycle?.incrementalExpectedCount ?? etfSummary.incrementalExpected, completed: etfLifecycle?.incrementalCompleted ?? etfSummary.incrementalCompleted, rows: null, earliestDate: null, latestDate: maxDate(etfLifecycle?.latestProviderDate, etfLifecycle?.latestDatabaseDate, etfSummary.latest), production: "PARTIAL_PRODUCTION", evidence: etfLifecycle?.currentRunStatus ?? "No production lifecycle", missing: ["Complete the resumable Global ETF universe", "Regional Daily counts are not isolated"] }),
      layer({ id: "nav", layer: "NAV", universe: etfSummary.universe, completed: null, coveragePercent: null, rows: etfNavRows, earliestDate: etfRows.find((row) => row.subcategory === "Taiwan ETF")?.earliestDatabaseDate ?? null, latestDate: etfRows.find((row) => row.subcategory === "Taiwan ETF")?.latestDatabaseDate ?? null, production: "DATA_ONLY", evidence: `${etfNavRows} NAV rows; product coverage is unverified`, missing: ["Per-ETF NAV coverage", "Global NAV incremental scheduler", "NAV validation"] }),
      layer({ id: "distribution", layer: "Distribution", universe: etfSummary.universe, completed: 0, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "0 canonical ETF distribution products", missing: ["Distribution history", "Incremental distribution updates"] }),
      layer({ id: "holdings", layer: "Holdings", universe: etfSummary.universe, completed: 0, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "0 canonical ETF holding products", missing: ["Holdings", "Holding weights", "Sector/Country/Asset allocation", "Portfolio date"] }),
      layer({ id: "corporate_actions", layer: "Corporate Actions", universe: etfSummary.universe, completed: 0, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "No complete ETF corporate-action production evidence", missing: ["Split", "Distribution", "Listing/Delisting", "Incremental updates"] }),
      layer({ id: "validation", layer: "Validation", universe: etfRows.length, completed: etfRows.filter((row) => row.validationStatus === "PASS").length, rows: etfRows.filter((row) => row.validationStatus === "PASS").length, earliestDate: null, latestDate: etfSummary.latest, production: "NOT_STARTED", evidence: "No regional ETF validation run passed in the completed audit", missing: ["Price validation", "NAV validation", "Holdings validation", "Distribution validation"] }),
      layer({ id: "scheduler", layer: "Scheduler", universe: etfRows.length, completed: etfRows.filter((row) => row.schedulerEnabled).length, rows: etfRows.filter((row) => row.schedulerEnabled).length, earliestDate: null, latestDate: audit.completedAt.slice(0, 10), production: "PARTIAL_PRODUCTION", evidence: `${etfRows.filter((row) => row.schedulerEnabled).length}/${etfRows.length} ETF regions scheduler-enabled`, missing: etfRows.filter((row) => !row.schedulerEnabled).map((row) => row.subcategory) }),
    ],
  };

  const fundSummary = summary("Fund");
  const fundRow = audit.rows.find((row) => row.category === "Fund" && row.subcategory.startsWith("All Funds"));
  const fund = required("fund");
  const fundLayers: AssetLayers = {
    order: fund.order,
    id: fund.id,
    asset: fund.name,
    currentUniverse: fundSummary.universe,
    runningStatus: fundRow?.currentRunStatus ?? "IDLE",
    layers: [
      layer({ id: "universe", layer: "Universe", universe: fundSummary.universe, completed: fundSummary.universe, rows: fundSummary.universe, earliestDate: null, latestDate: audit.completedAt.slice(0, 10), production: "PARTIAL_PRODUCTION", evidence: `${fundSummary.universe} funds; ${fundRow?.mappedCount ?? "UNKNOWN"} mapped`, missing: ["Domicile", "Share class", "Reliable regional classification"] }),
      layer({ id: "historical_nav", layer: "Historical NAV", universe: fundSummary.historicalExpected, completed: fundSummary.historicalCompleted, rows: fundSummary.historicalRows, earliestDate: fundSummary.earliest, latestDate: fundSummary.latest, production: "DATA_ONLY", evidence: `${fundSummary.historicalCompleted}/${fundSummary.historicalExpected}`, missing: [`${fundSummary.historicalExpected - Number(fundSummary.historicalCompleted ?? 0)} funds lack historical NAV`, "Row-level provenance"] }),
      layer({ id: "daily_nav", layer: "Daily NAV", universe: fundSummary.incrementalExpected, completed: fundSummary.incrementalCompleted, rows: null, earliestDate: null, latestDate: fundSummary.latest, production: "DATA_ONLY", evidence: `${fundSummary.incrementalCompleted}/${fundSummary.incrementalExpected} have latest NAV`, missing: ["Railway production scheduler", "Checkpoint/Resume evidence", "Daily validation ledger"] }),
      layer({ id: "distribution", layer: "Distribution", universe: fundSummary.universe, completed: 0, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "0 canonical fund distribution products", missing: ["Distribution history", "Incremental distribution updates"] }),
      layer({ id: "portfolio", layer: "Portfolio", universe: fundSummary.universe, completed: 0, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "0 canonical fund holding products", missing: ["Holdings", "Asset/Country/Sector allocation", "Credit quality", "Duration/Yield", "Expense ratio"] }),
      layer({ id: "validation", layer: "Validation", universe: 1, completed: fundRow?.validationStatus === "PASS" ? 1 : 0, rows: fundRow?.validationStatus === "PASS" ? 1 : 0, earliestDate: null, latestDate: fundSummary.latest, production: "NOT_STARTED", evidence: fundRow?.validationStatus ?? "NOT_RUN", missing: ["Historical NAV validation", "Latest NAV validation", "Portfolio validation", "Distribution validation"] }),
    ],
  };

  const standardRow = (category: string, job?: string) => {
    const base = audit.rows.find((row) => row.category === category);
    return base && job ? mergeRun(base, latestRuns.get(job), audit.completedAt) : base;
  };
  const governmentSummary = summary("Government Yields");
  const governmentRow = standardRow("Government Yields", "bond_yield-production-daily");
  const government = required("government-yield");
  const governmentLayers: AssetLayers = {
    order: government.order,
    id: government.id,
    asset: government.name,
    currentUniverse: governmentSummary.universe,
    runningStatus: governmentRow?.currentRunStatus ?? "IDLE",
    layers: [
      layer({ id: "universe", layer: "Universe", universe: governmentSummary.universe, completed: governmentSummary.universe, coveragePercent: null, rows: governmentSummary.universe, earliestDate: null, latestDate: audit.completedAt.slice(0, 10), production: "PARTIAL_PRODUCTION", evidence: `${governmentSummary.universe} configured series; global country/tenor target is not registered`, missing: ["Global country registry", "Complete tenor registry"] }),
      layer({ id: "historical", layer: "Historical", universe: governmentSummary.historicalExpected, completed: governmentSummary.historicalCompleted, rows: governmentSummary.historicalRows, earliestDate: governmentSummary.earliest, latestDate: governmentSummary.latest, production: "PRODUCTION", evidence: `${governmentSummary.historicalCompleted}/${governmentSummary.historicalExpected} configured series`, missing: [] }),
      layer({ id: "daily", layer: "Daily", universe: governmentRow?.incrementalExpectedCount ?? governmentSummary.incrementalExpected, completed: governmentRow?.incrementalCompleted ?? governmentSummary.incrementalCompleted, rows: null, earliestDate: null, latestDate: maxDate(governmentRow?.latestProviderDate, governmentRow?.latestDatabaseDate, governmentSummary.latest), production: "PRODUCTION", evidence: governmentRow?.currentRunStatus ?? "Completed audit evidence", missing: [] }),
      layer({ id: "yield_curve", layer: "Yield Curve", universe: governmentSummary.universe, completed: governmentSummary.universe, coveragePercent: null, rows: governmentSummary.historicalRows, earliestDate: governmentSummary.earliest, latestDate: governmentSummary.latest, production: "PARTIAL_PRODUCTION", evidence: "Only 5 configured yield series; complete country/tenor curve is not registered", missing: ["Overnight/1M/3M/6M/1Y/2Y/3Y/5Y/7Y/10Y/20Y/30Y by country"] }),
      layer({ id: "validation", layer: "Validation", universe: 1, completed: governmentRow?.validationStatus === "PASS" ? 1 : 0, rows: governmentRow?.validationStatus === "PASS" ? 1 : 0, earliestDate: null, latestDate: governmentSummary.latest, production: governmentRow?.validationStatus === "PASS" ? "PRODUCTION" : "NOT_STARTED", evidence: governmentRow?.validationStatus ?? "NOT_RUN", missing: governmentRow?.validationStatus === "PASS" ? [] : ["Production validation"] }),
    ],
  };

  const economicSummary = summary("Economic Data");
  const economicRow = standardRow("Economic Data", "macro-production-daily");
  const revisedRows = Number((economicRow?.details?.revisedRows as number | undefined) ?? 0);
  const economic = required("economic-data");
  const economicLayers: AssetLayers = {
    order: economic.order,
    id: economic.id,
    asset: economic.name,
    currentUniverse: economicSummary.universe,
    runningStatus: economicRow?.currentRunStatus ?? "IDLE",
    layers: [
      layer({ id: "universe", layer: "Universe", universe: economicSummary.universe, completed: economicSummary.universe, rows: economicSummary.universe, earliestDate: null, latestDate: audit.completedAt.slice(0, 10), production: "PRODUCTION", evidence: `${economicSummary.universe} series`, missing: [] }),
      layer({ id: "historical", layer: "Historical", universe: economicSummary.historicalExpected, completed: economicSummary.historicalCompleted, rows: economicSummary.historicalRows, earliestDate: economicSummary.earliest, latestDate: economicSummary.latest, production: "PRODUCTION", evidence: `${economicSummary.historicalCompleted}/${economicSummary.historicalExpected}`, missing: [] }),
      layer({ id: "revision_history", layer: "Revision", universe: economicSummary.historicalRows, completed: revisedRows, rows: revisedRows, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: `${revisedRows}/${economicSummary.historicalRows ?? 0} rows retain revisions`, missing: ["Initial release", "Revised value", "Revision date", "Vintage observations"] }),
      layer({ id: "incremental", layer: "Incremental", universe: economicRow?.incrementalExpectedCount ?? economicSummary.incrementalExpected, completed: economicRow?.incrementalCompleted ?? economicSummary.incrementalCompleted, rows: null, earliestDate: null, latestDate: maxDate(economicRow?.latestProviderDate, economicRow?.latestDatabaseDate, economicSummary.latest), production: "PARTIAL_PRODUCTION", evidence: economicRow?.currentRunStatus ?? "No lifecycle evidence", missing: ["IMF incremental", "OECD incremental", "World Bank incremental"] }),
      layer({ id: "validation", layer: "Validation", universe: 1, completed: economicRow?.validationStatus === "PASS" ? 1 : 0, rows: economicRow?.validationStatus === "PASS" ? 1 : 0, earliestDate: null, latestDate: economicSummary.latest, production: economicRow?.validationStatus === "PASS" ? "PRODUCTION" : "NOT_STARTED", evidence: economicRow?.validationStatus ?? "NOT_RUN", missing: economicRow?.validationStatus === "PASS" ? [] : ["Production validation"] }),
    ],
  };

  const simpleAsset = (id: "commodity" | "fx" | "crypto", category: string, schedulerId: "scheduler" | "scheduler_24_7"): AssetLayers => {
    const definition = required(id);
    const item = summary(category);
    const row = standardRow(category);
    return {
      order: definition.order,
      id: definition.id,
      asset: definition.name,
      currentUniverse: item.universe,
      runningStatus: row?.currentRunStatus ?? "IDLE",
      layers: [
        layer({ id: "universe", layer: "Universe", universe: item.universe, completed: item.universe, coveragePercent: null, rows: item.universe, earliestDate: null, latestDate: audit.completedAt.slice(0, 10), production: "DATA_ONLY", evidence: `${item.universe} configured instruments; full target universe is not registered`, missing: ["Complete canonical universe"] }),
        layer({ id: "historical", layer: "Historical", universe: item.historicalExpected, completed: item.historicalCompleted, rows: item.historicalRows, earliestDate: item.earliest, latestDate: item.latest, production: "DATA_ONLY", evidence: `${item.historicalCompleted}/${item.historicalExpected}`, missing: [`${item.historicalExpected - Number(item.historicalCompleted ?? 0)} configured instruments lack history`] }),
        layer({ id: "latest", layer: "Latest", universe: item.incrementalExpected, completed: item.incrementalCompleted, rows: null, earliestDate: null, latestDate: item.latest, production: "NOT_STARTED", evidence: "No Railway production incremental run", missing: [id === "crypto" ? "24/7 latest updater" : "Production incremental updater"] }),
        layer({ id: schedulerId, layer: id === "crypto" ? "24/7 Scheduler" : "Scheduler", universe: 1, completed: row?.schedulerEnabled ? 1 : 0, rows: row?.schedulerEnabled ? 1 : 0, earliestDate: null, latestDate: null, production: row?.schedulerEnabled ? "PARTIAL_PRODUCTION" : "NOT_STARTED", evidence: row?.schedulerRule ?? "NOT_CONFIGURED", missing: row?.schedulerEnabled ? [] : [id === "crypto" ? "24/7 scheduler" : "Production scheduler"] }),
        layer({ id: "validation", layer: "Validation", universe: 1, completed: row?.validationStatus === "PASS" ? 1 : 0, rows: row?.validationStatus === "PASS" ? 1 : 0, earliestDate: null, latestDate: item.latest, production: row?.validationStatus === "PASS" ? "PRODUCTION" : "NOT_STARTED", evidence: row?.validationStatus ?? "NOT_RUN", missing: row?.validationStatus === "PASS" ? [] : ["Production validation"] }),
      ],
    };
  };

  const bondSummary = summary("Bonds");
  const bond = required("bond");
  const bondLayers: AssetLayers = {
    order: bond.order,
    id: bond.id,
    asset: bond.name,
    currentUniverse: bondSummary.universe,
    runningStatus: "NOT_STARTED",
    layers: [
      layer({ id: "universe", layer: "Universe", universe: null, completed: 0, coveragePercent: null, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "No canonical individual bond universe", missing: ["Government bonds", "Corporate bonds", "Municipal/Agency bonds", "Convertible bonds"] }),
      layer({ id: "historical", layer: "Historical", universe: null, completed: 0, coveragePercent: null, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "No canonical bond history", missing: ["Historical price", "Historical yield", "Duration", "Spread"] }),
      layer({ id: "daily", layer: "Daily", universe: null, completed: 0, coveragePercent: null, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "No incremental bond lifecycle", missing: ["Latest price", "Latest yield", "Incremental scheduler"] }),
      layer({ id: "corporate", layer: "Corporate", universe: null, completed: 0, coveragePercent: null, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "No corporate bond universe", missing: ["Issuer", "Coupon", "Maturity", "Rating", "Call/Put features"] }),
      layer({ id: "yield", layer: "Yield", universe: null, completed: 0, coveragePercent: null, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "No individual bond yield layer", missing: ["YTM", "YTW", "OAS", "Credit spread"] }),
      layer({ id: "validation", layer: "Validation", universe: 1, completed: 0, rows: 0, earliestDate: null, latestDate: null, production: "NOT_STARTED", evidence: "NOT_RUN", missing: ["Bond validation"] }),
    ],
  };

  const assets = [
    stockLayers,
    etfLayers,
    fundLayers,
    governmentLayers,
    economicLayers,
    simpleAsset("commodity", "Commodities", "scheduler"),
    simpleAsset("fx", "FX", "scheduler"),
    simpleAsset("crypto", "Crypto", "scheduler_24_7"),
    bondLayers,
  ].sort((a, b) => a.order - b.order);

  for (const asset of assets) {
    const configured = required(asset.id).requiredLayers;
    const emitted = asset.layers.map((item) => item.id);
    const missing = configured.filter((id) => !emitted.includes(id));
    const unexpected = emitted.filter((id) => !configured.includes(id));
    if (missing.length || unexpected.length) throw new Error(`${asset.asset} layer mismatch; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`);
  }

  const missingMatrix = assets.flatMap((asset) => asset.layers.filter((item) => item.production !== "PRODUCTION" || item.missing.length > 0).map((item) => missingRecord(asset, item)));
  const dashboard = {
    generatedAt: new Date().toISOString(),
    mode: "ASSET_LAYER_PROGRESS_FROM_COMPLETED_AUDIT",
    compositePercentages: "PROHIBITED",
    baselineAudit: { runId: audit.runId, completedAt: audit.completedAt, file: relative(root, auditFile).replaceAll("\\", "/") },
    lifecycleRefresh: { mode: baselineOnly ? "BASELINE_ONLY" : "RUN_LEDGER_ONLY", error: refresh.error },
    roadmapVersion: roadmap.version,
    completionPolicy: roadmap.completionPolicy,
    currentAsset: assets.find((asset) => asset.layers.some((item) => item.production !== "PRODUCTION" || item.missing.length > 0))?.asset ?? null,
    assets,
  };

  const numberText = (value: NullableNumber): string => value === null ? "UNKNOWN" : value.toLocaleString("en-US");
  const coverageText = (value: NullableNumber): string => value === null ? "UNKNOWN" : `${value.toFixed(4)}%`;
  const bar = (value: NullableNumber): string => {
    if (value === null) return "[??????????]";
    const filled = Math.max(0, Math.min(10, Math.round(value / 10)));
    return `[${"#".repeat(filled)}${"-".repeat(10 - filled)}]`;
  };
  const layerSections = assets.map((asset) => `## ${asset.order}. ${asset.asset}\n\n| Layer | Progress | Completed | Universe | Coverage | Rows | Earliest | Latest | Production |\n| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |\n${asset.layers.map((item) => `| ${item.layer} | ${bar(item.coveragePercent)} | ${numberText(item.completed)} | ${numberText(item.universe)} | ${coverageText(item.coveragePercent)} | ${numberText(item.rows)} | ${item.earliestDate ?? "UNKNOWN"} | ${item.latestDate ?? "UNKNOWN"} | ${item.production} |`).join("\n")}\n`).join("\n");
  const dashboardMarkdown = `# SmartFund Asset Layer Dashboard

> Generated automatically at **${dashboard.generatedAt}** from completed Audit **${audit.runId}** plus a small read-only Run Ledger refresh. No new audit is executed. Asset/global composite percentages are intentionally prohibited.

Current production asset: **${dashboard.currentAsset ?? "All layers complete"}**

${layerSections}`;
  const missingMarkdown = `# SmartFund Global Missing Matrix

> Generated with the Asset Layer Dashboard at **${dashboard.generatedAt}**. Missing items are reported by layer and are never hidden inside an asset average.

| Order | Asset | Layer | Coverage | Production | Missing | Evidence |
| ---: | --- | --- | ---: | --- | --- | --- |
${missingMatrix.map((item) => `| ${item.order} | ${item.asset} | ${item.layer} | ${coverageText(item.coveragePercent)} | ${item.production} | ${item.missing.join("; ") || "Layer is not fully Production"} | ${item.evidence} |`).join("\n")}
`;
  const dashboardJson = `${JSON.stringify(dashboard, null, 2)}\n`;
  const missingJson = `${JSON.stringify({ generatedAt: dashboard.generatedAt, baselineAudit: dashboard.baselineAudit, missing: missingMatrix }, null, 2)}\n`;

  await Promise.all([mkdir(join(root, "config"), { recursive: true }), mkdir(join(root, "docs"), { recursive: true })]);
  await Promise.all([
    writeFile(join(root, "config", "asset-layer-dashboard.json"), dashboardJson),
    writeFile(join(root, "docs", "asset-layer-dashboard.md"), `${dashboardMarkdown.trimEnd()}\n`),
    writeFile(join(root, "config", "global-missing-matrix.json"), missingJson),
    writeFile(join(root, "docs", "global-missing-matrix.md"), `${missingMarkdown.trimEnd()}\n`),
    // Compatibility aliases keep existing readers on the same layer-only source.
    writeFile(join(root, "config", "global-asset-progress-dashboard.json"), dashboardJson),
    writeFile(join(root, "docs", "global-asset-progress-dashboard.md"), `${dashboardMarkdown.trimEnd()}\n`),
    writeFile(join(root, "config", "data-completion-dashboard.json"), dashboardJson),
    writeFile(join(root, "docs", "data-completion-dashboard.md"), `${dashboardMarkdown.trimEnd()}\n`),
  ]);
  console.log(JSON.stringify({ currentAsset: dashboard.currentAsset, compositePercentages: dashboard.compositePercentages, assets: assets.map((asset) => ({ asset: asset.asset, layers: asset.layers.map((item) => ({ layer: item.layer, coveragePercent: item.coveragePercent, production: item.production })) })), missingMatrixRows: missingMatrix.length }, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
