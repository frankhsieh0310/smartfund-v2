import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { PrismaClient } from "@prisma/client";

type NullableNumber = number | null;
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
  running: number;
  failed: number;
  retry: number;
  schedulers: number;
  gaps: string[];
  historicalCoveragePercent: NullableNumber;
  incrementalCoveragePercent: NullableNumber;
};
type AuditRow = {
  category: string;
  subcategory: string;
  universeCount: NullableNumber;
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
  mainBlockingIssue: string;
  details?: Record<string, unknown>;
};
type Audit = {
  runId: string;
  generatedAt: string;
  completedAt: string;
  rows: AuditRow[];
  categorySummary: AuditSummary[];
  tableCounts?: { end?: Record<string, number> };
};
type Roadmap = {
  version: string;
  completionFormula: string;
  assets: Array<{ order: number; id: string; name: string; requiredGates: string[] }>;
};
type Run = {
  job_id: string;
  run_type: string;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  attempted: NullableNumber;
  completed: NullableNumber;
  failed: NullableNumber;
  provider_latest_date: Date | null;
  latest_trading_date: Date | null;
  validation_status: string | null;
};
type Gate = {
  id: string;
  label: string;
  completed: NullableNumber;
  expected: NullableNumber;
  coveragePercent: number;
  evidence: string;
};
type AssetProgress = {
  order: number;
  id: string;
  asset: string;
  universe: { count: number; targetStatus: string };
  historical: { completed: NullableNumber; expected: number; coveragePercent: number; rows: NullableNumber };
  latest: { completed: NullableNumber; expected: number; coveragePercent: number; date: string | null };
  earliestDate: string | null;
  latestDate: string | null;
  rows: NullableNumber;
  rowBreakdown?: Record<string, NullableNumber>;
  gates: Gate[];
  productionPercent: number;
  status: "COMPLETE" | "IN_PRODUCTION" | "PARTIAL" | "NOT_STARTED";
  runningStatus: string;
  mainBlockingIssue: string;
};

const root = process.cwd();
const baselineOnly = process.argv.includes("--baseline-only");
const prisma = new PrismaClient();

const pct = (completed: NullableNumber, expected: NullableNumber): number =>
  completed === null || expected === null || expected <= 0 ? 0 : +Math.min(100, Math.max(0, completed / expected * 100)).toFixed(4);
const maxDate = (...values: Array<string | null | undefined>): string | null =>
  values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
const gate = (id: string, label: string, completed: NullableNumber, expected: NullableNumber, evidence: string): Gate => ({
  id,
  label,
  completed,
  expected,
  coveragePercent: pct(completed, expected),
  evidence,
});
const binaryGate = (id: string, label: string, passed: boolean, evidence: string): Gate => gate(id, label, passed ? 1 : 0, 1, evidence);

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
      // An incomplete audit directory is ignored; the latest completed artifact remains authoritative.
    }
  }
  throw new Error("No completed Global Data Audit artifact was found");
}

async function recentRuns(): Promise<{ runs: Run[]; error: string | null }> {
  if (baselineOnly) return { runs: [], error: null };
  try {
    const runs = await prisma.$queryRawUnsafe<Run[]>(
      "SELECT job_id,run_type,status,started_at,completed_at,attempted,completed,failed,provider_latest_date,latest_trading_date,validation_status FROM production_scheduler_runs WHERE started_at >= NOW()-INTERVAL '45 days' ORDER BY started_at DESC",
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

function baseAsset(
  roadmap: Roadmap["assets"][number],
  summary: AuditSummary,
  gates: Gate[],
  latestCompleted: NullableNumber = summary.incrementalCompleted,
  latestExpected = summary.incrementalExpected,
  latestDate = summary.latest,
  rows: NullableNumber = summary.historicalRows,
  runningStatus = summary.running > 0 ? "RUNNING" : "IDLE",
): AssetProgress {
  const productionPercent = +(gates.reduce((sum, item) => sum + item.coveragePercent, 0) / Math.max(1, gates.length)).toFixed(2);
  const status = productionPercent === 100 ? "COMPLETE" : runningStatus === "RUNNING" ? "IN_PRODUCTION" : summary.universe > 0 ? "PARTIAL" : "NOT_STARTED";
  const weakestGate = gates.reduce((weakest, item) => item.coveragePercent < weakest.coveragePercent ? item : weakest, gates[0]);
  return {
    order: roadmap.order,
    id: roadmap.id,
    asset: roadmap.name,
    universe: { count: summary.universe, targetStatus: "REGISTERED" },
    historical: {
      completed: summary.historicalCompleted,
      expected: summary.historicalExpected,
      coveragePercent: pct(summary.historicalCompleted, summary.historicalExpected),
      rows,
    },
    latest: { completed: latestCompleted, expected: latestExpected, coveragePercent: pct(latestCompleted, latestExpected), date: latestDate },
    earliestDate: summary.earliest,
    latestDate,
    rows,
    gates,
    productionPercent,
    status,
    runningStatus,
    mainBlockingIssue: weakestGate?.coveragePercent < 100 ? weakestGate.evidence : "None",
  };
}

function aggregateStockRows(rows: AuditRow[]): { expected: number; completed: number; latest: string | null; passed: number; schedulers: number; running: boolean } {
  return rows.reduce((result, row) => ({
    expected: result.expected + Number(row.universeCount ?? 0),
    completed: result.completed + Number(row.incrementalCompleted ?? 0),
    latest: maxDate(result.latest, row.latestProviderDate, row.latestDatabaseDate),
    passed: result.passed + (row.validationStatus === "PASS" ? 1 : 0),
    schedulers: result.schedulers + (row.schedulerEnabled ? 1 : 0),
    running: result.running || ["IN_PROGRESS", "RUNNING"].includes(row.currentRunStatus),
  }), { expected: 0, completed: 0, latest: null as string | null, passed: 0, schedulers: 0, running: false });
}

async function main(): Promise<void> {
  const [{ file: auditFile, audit }, roadmap, runRefresh] = await Promise.all([
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
  const roadmapById = new Map(roadmap.assets.map((asset) => [asset.id, asset]));
  const required = (id: string) => {
    const item = roadmapById.get(id);
    if (!item) throw new Error(`Roadmap is missing asset: ${id}`);
    return item;
  };
  const latestRuns = latestPrimaryByJob(runRefresh.runs);

  const stockAuditRows = audit.rows.filter((row) => row.category === "Global Stocks");
  const stockRows = stockAuditRows.map((row) => {
    const job = `${row.subcategory.toLowerCase().replaceAll(" ", "-")}-yahoo-daily`;
    return mergeRun(row, latestRuns.get(job), audit.completedAt);
  });
  const stockLive = aggregateStockRows(stockRows);
  const stock = summary("Global Stocks");
  const financial = summary("Financial Statements");
  const corporate = summary("Corporate Actions");
  const derived = summary("Derived Metrics");
  const stockGates = [
    gate("universe", "Universe", stock.universe, stock.universe, `${stock.universe.toLocaleString()} registered stocks`),
    gate("historical_price", "Historical Price", stock.historicalCompleted, stock.historicalExpected, `${stock.historicalCompleted ?? "UNKNOWN"}/${stock.historicalExpected}`),
    gate("daily_price", "Daily Price", stockLive.completed, stockLive.expected, `${stockLive.completed}/${stockLive.expected} in latest market runs`),
    gate("financial_statements", "Financial Statements", financial.historicalCompleted, financial.historicalExpected, "Per-stock coverage is UNKNOWN because the completed audit query exceeded the production statement timeout"),
    gate("corporate_actions", "Corporate Actions", corporate.historicalCompleted, corporate.historicalExpected, "No canonical stock corporate-action production ledger"),
    gate("derived_metrics", "Derived Metrics", derived.historicalCompleted, derived.historicalExpected, `${derived.historicalCompleted ?? 0}/${derived.historicalExpected}; lower-bound evidence only`),
    gate("validation", "Validation", stockLive.passed, stockRows.length, `${stockLive.passed}/${stockRows.length} market latest runs validated PASS`),
    gate("production_scheduler", "Production Scheduler", stockLive.schedulers, stockRows.length, `${stockLive.schedulers}/${stockRows.length} markets scheduler-enabled`),
  ];
  const stockAsset = baseAsset(required("stocks"), stock, stockGates, stockLive.completed, stockLive.expected, stockLive.latest, audit.tableCounts?.end?.stock_history ?? stock.historicalRows, stockLive.running ? "RUNNING" : "IDLE");
  stockAsset.rowBreakdown = {
    historicalPrice: audit.tableCounts?.end?.stock_history ?? null,
    financialFacts: audit.tableCounts?.end?.stock_financial_facts ?? null,
    corporateActions: corporate.historicalRows,
    derivedMetrics: derived.historicalRows,
  };
  stockAsset.rows = Object.values(stockAsset.rowBreakdown).reduce<number>((sum, value) => sum + Number(value ?? 0), 0);

  const etfSummary = summary("ETF");
  const etfRows = audit.rows.filter((row) => row.category === "ETF" && row.subcategory !== "Global ETF Production Daily Lifecycle");
  const etfLifecycleBase = audit.rows.find((row) => row.category === "ETF" && row.subcategory === "Global ETF Production Daily Lifecycle");
  const etfLifecycle = etfLifecycleBase ? mergeRun(etfLifecycleBase, latestRuns.get("global_etf-production-daily"), audit.completedAt) : null;
  const etfNavRows = etfRows.reduce((sum, row) => sum + Number((row.details?.navRows as number | undefined) ?? 0), 0);
  const etfGates = [
    gate("universe", "Universe", etfSummary.universe, etfSummary.universe, `${etfSummary.universe} registered ETFs`),
    gate("historical_price", "Historical Price", etfSummary.historicalCompleted, etfSummary.historicalExpected, `${etfSummary.historicalCompleted}/${etfSummary.historicalExpected}`),
    gate("daily_price", "Daily Price", etfLifecycle?.incrementalCompleted ?? etfSummary.incrementalCompleted, etfLifecycle?.incrementalExpectedCount ?? etfSummary.incrementalExpected, etfLifecycle?.currentRunStatus ?? "No production lifecycle evidence"),
    gate("nav", "NAV", null, etfSummary.universe, `${etfNavRows} NAV rows exist, but product coverage was not verified`),
    gate("distribution", "Distribution", 0, etfSummary.universe, "0 ETF products with canonical distributions in the completed audit"),
    gate("holdings", "Holdings", 0, etfSummary.universe, "0 ETF products with canonical holdings in the completed audit"),
    gate("corporate_actions", "Corporate Actions", 0, etfSummary.universe, "No complete ETF corporate-action production evidence"),
    gate("derived_metrics", "Derived Metrics", 0, etfSummary.universe, "No complete ETF derived-metric production evidence"),
    gate("validation", "Validation", etfRows.filter((row) => row.validationStatus === "PASS").length, etfRows.length, "Regional validation evidence"),
    binaryGate("production_scheduler", "Production Scheduler", etfLifecycle?.productionStatus === "PRODUCTION" && etfLifecycle.validationStatus === "PASS", etfLifecycle?.currentRunStatus ?? "No completed validated lifecycle"),
  ];
  const etfAsset = baseAsset(required("etf"), etfSummary, etfGates, etfLifecycle?.incrementalCompleted ?? etfSummary.incrementalCompleted, etfLifecycle?.incrementalExpectedCount ?? etfSummary.incrementalExpected, maxDate(etfLifecycle?.latestProviderDate, etfLifecycle?.latestDatabaseDate, etfSummary.latest), etfSummary.historicalRows, etfLifecycle && ["IN_PROGRESS", "RUNNING"].includes(etfLifecycle.currentRunStatus) ? "RUNNING" : etfLifecycle?.currentRunStatus ?? "IDLE");

  const fundSummary = summary("Fund");
  const fundRow = audit.rows.find((row) => row.category === "Fund" && row.subcategory.startsWith("All Funds"));
  const fundGates = [
    gate("universe", "Universe", fundSummary.universe, fundSummary.universe, `${fundSummary.universe} registered funds`),
    gate("historical_nav", "Historical NAV", fundSummary.historicalCompleted, fundSummary.historicalExpected, `${fundSummary.historicalCompleted}/${fundSummary.historicalExpected}`),
    gate("daily_nav", "Daily NAV", fundSummary.incrementalCompleted, fundSummary.incrementalExpected, `${fundSummary.incrementalCompleted}/${fundSummary.incrementalExpected}`),
    gate("distribution", "Distribution", 0, fundSummary.universe, "0 canonical fund distribution products in the completed audit"),
    gate("portfolio", "Portfolio", 0, fundSummary.universe, "0 canonical fund holding products in the completed audit"),
    gate("characteristics", "Characteristics", 0, fundSummary.universe, "Domicile/share-class characteristics are not normalized"),
    binaryGate("validation", "Validation", fundRow?.validationStatus === "PASS", fundRow?.validationStatus ?? "NOT_RUN"),
    binaryGate("production_scheduler", "Production Scheduler", fundRow?.schedulerEnabled === true && fundRow.productionStatus === "PRODUCTION", fundRow?.schedulerRule ?? "NOT_CONFIGURED"),
  ];
  const fundAsset = baseAsset(required("fund"), fundSummary, fundGates);

  const standard = (
    id: string,
    category: string,
    options: { targetRegistered?: boolean; extraGates?: Gate[]; job?: string; historicalGateId?: string } = {},
  ): AssetProgress => {
    const item = summary(category);
    const baseRow = audit.rows.find((row) => row.category === category);
    const liveRow = baseRow && options.job ? mergeRun(baseRow, latestRuns.get(options.job), audit.completedAt) : baseRow;
    const universeGate = options.targetRegistered === false
      ? binaryGate("universe", "Universe", false, `${item.universe} configured; full target universe is not registered`)
      : gate("universe", "Universe", item.universe, item.universe, `${item.universe} registered instruments/series`);
    const gates = [
      universeGate,
      gate(options.historicalGateId ?? "historical", "Historical", item.historicalCompleted, item.historicalExpected, `${item.historicalCompleted ?? "UNKNOWN"}/${item.historicalExpected}`),
      ...(options.extraGates ?? []),
      gate(id === "crypto" ? "incremental_24_7" : "incremental", id === "crypto" ? "Incremental 24/7" : "Incremental", liveRow?.incrementalCompleted ?? item.incrementalCompleted, liveRow?.incrementalExpectedCount ?? item.incrementalExpected, liveRow?.currentRunStatus ?? "No lifecycle evidence"),
      binaryGate("validation", "Validation", liveRow?.validationStatus === "PASS", liveRow?.validationStatus ?? "NOT_RUN"),
      binaryGate("production_scheduler", "Production Scheduler", liveRow?.schedulerEnabled === true && liveRow.productionStatus === "PRODUCTION", liveRow?.schedulerRule ?? "NOT_CONFIGURED"),
    ];
    return baseAsset(required(id), item, gates, liveRow?.incrementalCompleted ?? item.incrementalCompleted, liveRow?.incrementalExpectedCount ?? item.incrementalExpected, maxDate(liveRow?.latestProviderDate, liveRow?.latestDatabaseDate, item.latest), item.historicalRows, liveRow && ["IN_PROGRESS", "RUNNING"].includes(liveRow.currentRunStatus) ? "RUNNING" : liveRow?.currentRunStatus ?? "IDLE");
  };

  const economicSummary = summary("Economic Data");
  const economicRow = audit.rows.find((row) => row.category === "Economic Data" && row.subcategory === "All Economic Series");
  const revisionRows = Number((economicRow?.details?.revisedRows as number | undefined) ?? 0);
  const economicAsset = standard("economic-data", "Economic Data", {
    job: "macro-production-daily",
    extraGates: [gate("revision_history", "Revision History", revisionRows, economicSummary.historicalRows, `${revisionRows}/${economicSummary.historicalRows ?? 0} rows retain revision history; vintage observations are not preserved`)],
  });
  const commodityAsset = standard("commodity", "Commodities", { targetRegistered: false });
  commodityAsset.rowBreakdown = {
    canonicalCommodity: summary("Commodities").historicalRows,
    preciousMetal: summary("Precious Metals").historicalRows,
    energy: summary("Energy").historicalRows,
  };
  const bondAsset = standard("bond", "Bonds", {
    targetRegistered: false,
    historicalGateId: "historical_price_yield",
    extraGates: [gate("spread", "Spread", 0, 1, "No canonical bond spread production evidence")],
  });
  const assets = [
    stockAsset,
    etfAsset,
    fundAsset,
    standard("government-yield", "Government Yields", { targetRegistered: false, job: "bond_yield-production-daily" }),
    economicAsset,
    commodityAsset,
    standard("fx", "FX", { targetRegistered: false }),
    standard("crypto", "Crypto", { targetRegistered: false }),
    bondAsset,
  ].sort((a, b) => a.order - b.order);

  for (const asset of assets) {
    const configured = required(asset.id).requiredGates;
    const emitted = new Set(asset.gates.map((item) => item.id));
    const missing = configured.filter((id) => !emitted.has(id));
    const unexpected = asset.gates.map((item) => item.id).filter((id) => !configured.includes(id));
    if (missing.length || unexpected.length) throw new Error(`${asset.asset} gate mismatch; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`);
  }

  const currentAsset = assets.find((asset) => asset.productionPercent < 100) ?? null;
  const globalProductionPercent = +(assets.reduce((sum, asset) => sum + asset.productionPercent, 0) / assets.length).toFixed(2);
  const dashboard = {
    generatedAt: new Date().toISOString(),
    mode: "PRODUCTION_PROGRESS_FROM_COMPLETED_AUDIT",
    baselineAudit: { runId: audit.runId, completedAt: audit.completedAt, file: relative(root, auditFile).replaceAll("\\", "/") },
    lifecycleRefresh: { mode: baselineOnly ? "BASELINE_ONLY" : "RUN_LEDGER_ONLY", error: runRefresh.error },
    roadmapVersion: roadmap.version,
    completionFormula: roadmap.completionFormula,
    globalProductionPercent,
    currentAsset: currentAsset?.asset ?? null,
    assets,
  };

  const numberText = (value: NullableNumber): string => value === null ? "UNKNOWN" : value.toLocaleString("en-US");
  const ratioText = (completed: NullableNumber, expected: number, coverage: number): string => `${numberText(completed)} / ${numberText(expected)} (${coverage.toFixed(4)}%)`;
  const table = assets.map((asset) => `| ${asset.order} | ${asset.asset} | ${numberText(asset.universe.count)} | ${ratioText(asset.historical.completed, asset.historical.expected, asset.historical.coveragePercent)} | ${ratioText(asset.latest.completed, asset.latest.expected, asset.latest.coveragePercent)} | ${numberText(asset.rows)} | ${asset.earliestDate ?? "UNKNOWN"} | ${asset.latestDate ?? "UNKNOWN"} | ${asset.productionPercent.toFixed(2)}% | ${asset.status} | ${asset.mainBlockingIssue} |`).join("\n");
  const gates = assets.flatMap((asset) => [
    `### ${asset.order}. ${asset.asset}`,
    "",
    "| Gate | Completed | Expected | Coverage | Evidence |",
    "| --- | ---: | ---: | ---: | --- |",
    ...asset.gates.map((item) => `| ${item.label} | ${numberText(item.completed)} | ${numberText(item.expected)} | ${item.coveragePercent.toFixed(4)}% | ${item.evidence} |`),
    "",
  ]).join("\n");
  const markdown = `# SmartFund Global Asset Progress Dashboard

> Generated automatically at **${dashboard.generatedAt}**. Coverage baseline is the already-completed Global Data Audit **${audit.runId}**; this dashboard does **not** rerun that audit. Production lifecycle evidence is refreshed from the small Run Ledger only. Unknown required gates score 0 and are never guessed.

## Global Production: ${globalProductionPercent.toFixed(2)}%

Current asset: **${dashboard.currentAsset ?? "All complete"}**

| Order | Asset | Universe | Historical | Latest | Rows | Earliest | Latest Date | Production | Status | Main Gap |
| ---: | --- | ---: | --- | --- | ---: | --- | --- | ---: | --- | --- |
${table}

## Production Gates

${gates}
`;
  const markdownOutput = `${markdown.trimEnd()}\n`;

  await Promise.all([
    mkdir(join(root, "config"), { recursive: true }),
    mkdir(join(root, "docs"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "config", "global-asset-progress-dashboard.json"), `${JSON.stringify(dashboard, null, 2)}\n`),
    writeFile(join(root, "docs", "global-asset-progress-dashboard.md"), markdownOutput),
    // Compatibility aliases keep existing consumers on the same single source.
    writeFile(join(root, "config", "data-completion-dashboard.json"), `${JSON.stringify(dashboard, null, 2)}\n`),
    writeFile(join(root, "docs", "data-completion-dashboard.md"), markdownOutput),
  ]);
  console.log(JSON.stringify({ globalProductionPercent, currentAsset: dashboard.currentAsset, assets: assets.map((asset) => ({ order: asset.order, asset: asset.asset, productionPercent: asset.productionPercent })) }, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
