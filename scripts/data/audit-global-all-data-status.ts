/**
 * SmartFund Global Data Backfill & Incremental Status Audit.
 *
 * Production database access in this file is strictly read-only. The only
 * writes are the requested local Markdown/JSON/CSV audit artifacts.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

type RunRow = {
  id: string; job_id: string; run_type: string; status: string; started_at: Date; completed_at: Date | null;
  universe_count: number; attempted: number; completed: number; failed: number; no_update_count: number;
  permanent_unavailable_count: number; retryable_failure_count: number; latest_trading_date: Date | null;
  target_trade_date: Date | null; provider_latest_date: Date | null; validation_status: string | null;
  validation_details: Record<string, unknown> | null; exit_code: number | null; error: string | null;
};

type AuditRow = {
  category: string;
  subcategory: string;
  providerSource: string;
  availabilityStatus: "AVAILABLE_AND_INGESTED" | "AVAILABLE_NOT_CONNECTED" | "PARTIALLY_AVAILABLE" | "SOURCE_RESEARCH_REQUIRED" | "NOT_PUBLICLY_AVAILABLE" | "PROVIDER_REQUIRED";
  universeCount: number | null;
  activeCount: number | null;
  mappedCount: number | null;
  historicalExpectedCount: number | null;
  historicalCompletedCount: number | null;
  historicalCoveragePercent: number | null;
  historicalRowCount: number | null;
  earliestAvailableDate: string | null;
  earliestDatabaseDate: string | null;
  latestProviderDate: string | null;
  latestDatabaseDate: string | null;
  incrementalExpectedCount: number | null;
  incrementalAttempted: number | null;
  incrementalCompleted: number | null;
  incrementalFailed: number | null;
  incrementalCoveragePercent: number | null;
  noUpdateCount: number | null;
  noDataCount: number | null;
  staleCount: number | null;
  retryQueueCount: number | null;
  retryRecoveredCount: number | null;
  permanentFailureCount: number | null;
  lastSuccessfulRun: string | null;
  currentRunStatus: string;
  currentCheckpoint: string | null;
  activeLock: boolean;
  lastHeartbeat: string | null;
  schedulerEnabled: boolean;
  schedulerRule: string;
  schedulerTimezone: string;
  updateFrequency: string;
  validationStatus: string;
  productionStatus: "PRODUCTION" | "PARTIAL" | "PROTOTYPE" | "NOT_STARTED" | "SOURCE_NOT_AVAILABLE";
  mainBlockingIssue: string;
  details: Record<string, unknown>;
};

type Gap = {
  gapType: string; category: string; market: string; instrument: string; missingComponent: string;
  currentCoverage: string; blockingReason: string; existingScript: string; existingDataSource: string;
  currentWorkerStatus: string; nextExecutableAction: string;
};

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const root = process.cwd();
const requestedRunId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9);
const runId = requestedRunId ?? new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z");
const errors: string[] = [];

function n(value: unknown): number { return Number(value ?? 0); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
function iso(value: unknown): string | null { return value ? new Date(String(value)).toISOString() : null; }
function day(value: unknown): string | null { return value ? new Date(String(value)).toISOString().slice(0, 10) : null; }
function pct(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator === 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(4));
}
function coverage(numerator: number | null, denominator: number | null): string {
  const rate = pct(numerator, denominator);
  return `${numerator ?? "UNKNOWN"} / ${denominator ?? "UNKNOWN"}${rate === null ? "" : ` = ${rate.toFixed(4)}%`}`;
}
function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? Number(item) : item, 2);
}
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? safeJson(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function query<T extends Record<string, unknown>>(label: string, sql: string, ...params: unknown[]): Promise<T[]> {
  console.error(`[audit] ${label}`);
  if (["stock history by market", "financial facts by market", "technical rows by market"].includes(label)) {
    errors.push(`${label}: exact aggregation previously verified to exceed the production statement timeout; fallback evidence is used to avoid impacting live ingestion`);
    return [];
  }
  try { return await prisma.$queryRawUnsafe<T[]>(sql, ...params); }
  catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); return []; }
}

const marketCase = (alias: string): string => `CASE
  WHEN ${alias}.country='TW' AND ${alias}.exchange='TWSE' THEN 'TWSE'
  WHEN ${alias}.country='TW' AND ${alias}.exchange='TPEx' THEN 'TPEx'
  WHEN ${alias}.country='US' AND ${alias}.exchange IN ('NASDAQ','NMS','NGM','NCM') THEN 'NASDAQ'
  WHEN ${alias}.country='US' AND ${alias}.exchange IN ('NYSE','NYQ') THEN 'NYSE'
  WHEN ${alias}.country='US' AND ${alias}.exchange IN ('AMEX','ASE') THEN 'AMEX'
  WHEN ${alias}.country='JP' AND ${alias}.exchange='JPX' THEN 'Japan'
  WHEN ${alias}.country='KR' AND ${alias}.exchange IN ('KOE','KSC') THEN 'Korea'
  WHEN ${alias}.country='HK' AND ${alias}.exchange='HKG' THEN 'Hong Kong'
  WHEN ${alias}.country='CA' AND ${alias}.exchange IN ('TOR','NEO','VAN','CNQ') THEN 'Canada'
  WHEN ${alias}.country='AU' AND ${alias}.exchange IN ('ASX','CXA') THEN 'Australia'
  WHEN ${alias}.country='DE' AND ${alias}.exchange IN ('FRA','GER','STU','MUN','DUS','HAM','HAN') THEN 'Germany'
  WHEN ${alias}.country='FR' AND ${alias}.exchange IN ('ENX','PAR') THEN 'France'
  WHEN ${alias}.country='GB' AND ${alias}.exchange IN ('LSE','CXE','IOB','AQS') THEN 'United Kingdom'
  WHEN ${alias}.country='ES' AND ${alias}.exchange='MCE' THEN 'Spain'
  WHEN ${alias}.country='IT' AND ${alias}.exchange IN ('MIL','TLO') THEN 'Italy'
  WHEN ${alias}.country='NL' AND ${alias}.exchange IN ('DXE','AMS') THEN 'Netherlands'
  ELSE 'Other:' || COALESCE(${alias}.country,'NULL') || ':' || COALESCE(${alias}.exchange,'NULL') END`;

function availability(universe: number | null, rows: number | null, scheduled: boolean, partial = false): AuditRow["availabilityStatus"] {
  if (rows !== null && rows > 0) return partial || !scheduled ? "PARTIALLY_AVAILABLE" : "AVAILABLE_AND_INGESTED";
  if (universe !== null && universe > 0) return "AVAILABLE_NOT_CONNECTED";
  return "SOURCE_RESEARCH_REQUIRED";
}
function production(universe: number | null, rows: number | null, scheduled: boolean): AuditRow["productionStatus"] {
  if (rows !== null && rows > 0 && scheduled) return "PRODUCTION";
  if (rows !== null && rows > 0) return "PARTIAL";
  if (universe !== null && universe > 0) return "PROTOTYPE";
  return "NOT_STARTED";
}

function latestRunMaps(runs: RunRow[]): { any: Map<string, RunRow>; primary: Map<string, RunRow>; success: Map<string, RunRow> } {
  const any = new Map<string, RunRow>(); const primary = new Map<string, RunRow>(); const success = new Map<string, RunRow>();
  for (const row of runs) {
    if (!any.has(row.job_id)) any.set(row.job_id, row);
    if (row.run_type === "PRIMARY" && !primary.has(row.job_id)) primary.set(row.job_id, row);
    if (row.status === "COMPLETED" && row.validation_status === "PASS" && row.exit_code === 0 && !success.has(row.job_id)) success.set(row.job_id, row);
  }
  return { any, primary, success };
}

function runFields(jobId: string, runMaps: ReturnType<typeof latestRunMaps>, checkpoints: Map<string, Record<string, unknown>>, locks: Map<string, Record<string, unknown>>, failures: Map<string, Record<string, unknown>>) {
  const current = runMaps.any.get(jobId); const base = runMaps.primary.get(jobId) ?? current; const lastSuccess = runMaps.success.get(jobId);
  const checkpoint = checkpoints.get(jobId); const lock = locks.get(jobId); const failure = failures.get(jobId);
  const retryRecovered = nullableNumber(base?.validation_details?.retryRecovered ?? (base?.run_type === "RETRY" ? base.completed : 0));
  return {
    latestProviderDate: day(base?.provider_latest_date ?? base?.latest_trading_date),
    incrementalAttempted: base?.attempted ?? null,
    incrementalCompleted: base?.completed ?? null,
    incrementalFailed: base?.failed ?? null,
    noUpdateCount: base?.no_update_count ?? null,
    noDataCount: base?.permanent_unavailable_count ?? null,
    staleCount: base?.retryable_failure_count ?? null,
    retryQueueCount: nullableNumber(failure?.retryable),
    retryRecoveredCount: retryRecovered,
    permanentFailureCount: nullableNumber(failure?.permanent),
    lastSuccessfulRun: iso(lastSuccess?.completed_at),
    currentRunStatus: lock ? "RUNNING" : current?.status ?? "NOT_STARTED",
    currentCheckpoint: checkpoint ? `${String(checkpoint.last_symbol ?? "")}; ${n(checkpoint.processed)}/${n(checkpoint.succeeded)}/${n(checkpoint.failed)}` : null,
    activeLock: Boolean(lock),
    lastHeartbeat: iso(lock?.updated_at ?? checkpoint?.updated_at),
    validationStatus: base?.validation_status ?? "NOT_RUN",
    runEvidence: base ? { id: base.id, runType: base.run_type, status: base.status, targetTradeDate: day(base.target_trade_date), exitCode: base.exit_code, error: base.error } : null,
  };
}

function baseRow(input: Partial<AuditRow> & Pick<AuditRow, "category" | "subcategory">): AuditRow {
  return {
    category: input.category, subcategory: input.subcategory, providerSource: input.providerSource ?? "UNCONFIRMED",
    availabilityStatus: input.availabilityStatus ?? "SOURCE_RESEARCH_REQUIRED",
    universeCount: input.universeCount ?? null, activeCount: input.activeCount ?? null, mappedCount: input.mappedCount ?? null,
    historicalExpectedCount: input.historicalExpectedCount ?? null, historicalCompletedCount: input.historicalCompletedCount ?? null,
    historicalCoveragePercent: input.historicalCoveragePercent ?? null, historicalRowCount: input.historicalRowCount ?? null,
    earliestAvailableDate: input.earliestAvailableDate ?? null, earliestDatabaseDate: input.earliestDatabaseDate ?? null,
    latestProviderDate: input.latestProviderDate ?? null, latestDatabaseDate: input.latestDatabaseDate ?? null,
    incrementalExpectedCount: input.incrementalExpectedCount ?? null, incrementalAttempted: input.incrementalAttempted ?? null,
    incrementalCompleted: input.incrementalCompleted ?? null, incrementalFailed: input.incrementalFailed ?? null,
    incrementalCoveragePercent: input.incrementalCoveragePercent ?? null, noUpdateCount: input.noUpdateCount ?? null,
    noDataCount: input.noDataCount ?? null, staleCount: input.staleCount ?? null, retryQueueCount: input.retryQueueCount ?? null,
    retryRecoveredCount: input.retryRecoveredCount ?? null, permanentFailureCount: input.permanentFailureCount ?? null,
    lastSuccessfulRun: input.lastSuccessfulRun ?? null, currentRunStatus: input.currentRunStatus ?? "NOT_STARTED",
    currentCheckpoint: input.currentCheckpoint ?? null, activeLock: input.activeLock ?? false, lastHeartbeat: input.lastHeartbeat ?? null,
    schedulerEnabled: input.schedulerEnabled ?? false, schedulerRule: input.schedulerRule ?? "NOT_CONFIGURED",
    schedulerTimezone: input.schedulerTimezone ?? "NOT_CONFIGURED", updateFrequency: input.updateFrequency ?? "NOT_CONFIGURED",
    validationStatus: input.validationStatus ?? "NOT_RUN", productionStatus: input.productionStatus ?? "NOT_STARTED",
    mainBlockingIssue: input.mainBlockingIssue ?? "None evidenced", details: input.details ?? {},
  };
}

async function tableCounts(): Promise<Record<string, number>> {
  const rows = await query<{ table_name: string; count: unknown }>("table activity estimates", `
    SELECT relname AS table_name, n_live_tup::bigint AS count
    FROM pg_stat_user_tables
    WHERE relname = ANY(ARRAY['stock_history','stock_financial_facts','stock_technical','etf_history','fund_history','market_history','index_history','economic_values','asset_performances'])`);
  return Object.fromEntries(rows.map((row) => [row.table_name, n(row.count)]));
}

async function main(): Promise<void> {
  const generatedAt = new Date();
  const startCounts = await tableCounts();
  const registry = JSON.parse(await readFile(join(root, "config", "production-yahoo-daily-jobs.json"), "utf8")) as { pollIntervalMinutes: number; jobs: Array<Record<string, unknown>> };
  const dailySchedule = JSON.parse(await readFile(join(root, "config", "data-daily-schedule.json"), "utf8")) as { jobs: Array<Record<string, unknown>> };
  const registryByMarket = new Map(registry.jobs.map((job) => [String(job.market), job]));

  const runs = await query<RunRow>("run ledger", "SELECT id,job_id,run_type,status,started_at,completed_at,universe_count,attempted,completed,failed,no_update_count,permanent_unavailable_count,retryable_failure_count,latest_trading_date,target_trade_date,provider_latest_date,validation_status,validation_details,exit_code,error FROM production_scheduler_runs ORDER BY started_at DESC");
  const runMaps = latestRunMaps(runs);
  const checkpointRows = await query<Record<string, unknown>>("checkpoints", "SELECT DISTINCT ON (job_id) job_id,last_symbol,processed,succeeded,failed,target_trade_date,run_type,updated_at FROM production_scheduler_checkpoints ORDER BY job_id,updated_at DESC");
  const checkpointMap = new Map(checkpointRows.map((row) => [String(row.job_id), row]));
  const lockRows = await query<Record<string, unknown>>("locks", "SELECT job_id,owner,expires_at,updated_at FROM production_scheduler_locks WHERE expires_at>NOW() AND updated_at>NOW()-INTERVAL '10 minutes'");
  const lockMap = new Map(lockRows.map((row) => [String(row.job_id), row]));
  const failureRows = await query<Record<string, unknown>>("failure queue", "SELECT job_id,COUNT(*) FILTER(WHERE resolved=FALSE)::int open,COUNT(*) FILTER(WHERE resolved=FALSE AND classification='RETRYABLE_FAILURE')::int retryable,COUNT(*) FILTER(WHERE resolved=FALSE AND classification='PERMANENT_UNAVAILABLE')::int permanent,COUNT(*) FILTER(WHERE resolved=TRUE AND resolution_reason='RETRY_RECOVERED')::int recovered FROM production_scheduler_failures GROUP BY job_id");
  const failureMap = new Map(failureRows.map((row) => [String(row.job_id), row]));

  const stockMaster = await query<Record<string, unknown>>("stock master by market", `WITH tagged AS (SELECT ${marketCase("s")} market,s.* FROM stocks s) SELECT market,COUNT(*)::int universe,COUNT(*) FILTER(WHERE is_active)::int active,COUNT(*) FILTER(WHERE NOT is_active)::int inactive,COUNT(*) FILTER(WHERE status::text='DELISTED')::int delisted,COUNT(*) FILTER(WHERE COALESCE(yahoo_symbol,'')='')::int missing_yahoo,COUNT(*) FILTER(WHERE history_backfilled_at IS NOT NULL)::int backfill_flag,COUNT(*) FILTER(WHERE latest_date IS NOT NULL)::int latest_mapped,MAX(latest_date) latest_date FROM tagged GROUP BY market ORDER BY market`);
  const stockHistory = await query<Record<string, unknown>>("stock history by market", `WITH tagged AS (SELECT ${marketCase("s")} market,s.id FROM stocks s) SELECT t.market,COUNT(*)::bigint rows,COUNT(DISTINCT h.stock_id)::int products,MIN(h.date) earliest,MAX(h.date) latest,COUNT(*) FILTER(WHERE h.open IS NOT NULL AND h.high IS NOT NULL AND h.low IS NOT NULL AND h.adjusted_close IS NOT NULL AND h.volume IS NOT NULL)::bigint complete_ohlcv,COUNT(*) FILTER(WHERE h.source='YAHOO')::bigint yahoo_rows FROM stock_history h JOIN tagged t ON t.id=h.stock_id GROUP BY t.market`);
  const financial = await query<Record<string, unknown>>("financial facts by market", `WITH tagged AS (SELECT ${marketCase("s")} market,s.id FROM stocks s) SELECT t.market,COUNT(*)::bigint rows,COUNT(DISTINCT f.stock_id)::int stocks,MIN(f.period_end) earliest,MAX(f.period_end) latest,string_agg(DISTINCT f.source,', ' ORDER BY f.source) sources,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(revenue|營業收入|收益)')::int revenue_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(gross_profit|毛利)')::int gross_profit_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(operating_income|營業利益|營業損益)')::int operating_income_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(net_income|本期淨利|淨利)')::int net_income_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(basic_eps|基本每股盈餘)')::int basic_eps_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(diluted_eps|稀釋每股盈餘)')::int diluted_eps_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(total_assets|資產總額)')::int assets_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(total_liabilities|負債總額)')::int liabilities_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(equity|權益)')::int equity_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(cash_and_cash|現金及約當現金)')::int cash_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(debt|借款|應付債券)')::int debt_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(operating_cash_flow|營業活動之淨現金流)')::int operating_cash_flow_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(free_cash_flow)')::int free_cash_flow_stocks,COUNT(DISTINCT f.stock_id) FILTER(WHERE f.metric ~* '(shares_outstanding|流通在外股數|股本股數)')::int shares_stocks FROM stock_financial_facts f JOIN tagged t ON t.id=f.stock_id GROUP BY t.market`);
  const technical = await query<Record<string, unknown>>("technical rows by market", `WITH tagged AS (SELECT ${marketCase("s")} market,s.id FROM stocks s) SELECT t.market,COUNT(*)::bigint rows,COUNT(DISTINCT x.stock_id)::int stocks,MIN(x.date) earliest,MAX(x.date) latest FROM stock_technical x JOIN tagged t ON t.id=x.stock_id GROUP BY t.market`);
  const ratioFacts = await query<Record<string, unknown>>("derived financial facts by market", `WITH tagged AS (SELECT ${marketCase("s")} market,s.id FROM stocks s) SELECT t.market,COUNT(*)::bigint rows,COUNT(DISTINCT f.stock_id)::int stocks,MIN(f.period_end) earliest,MAX(f.period_end) latest,string_agg(DISTINCT f.metric,', ' ORDER BY f.metric) metrics FROM stock_financial_facts f JOIN tagged t ON t.id=f.stock_id WHERE f.metric ~* '^(valuation|ratio|derived)\\.' OR f.metric ~* '(return_on|margin|enterprise_value|market_cap|dividend_yield|debt_to|price_to_)' GROUP BY t.market`);
  const historyByMarket = new Map(stockHistory.map((row) => [String(row.market), row]));
  const financialByMarket = new Map(financial.map((row) => [String(row.market), row]));
  const technicalByMarket = new Map(technical.map((row) => [String(row.market), row]));
  const ratioByMarket = new Map(ratioFacts.map((row) => [String(row.market), row]));
  const stockHistoryQueryFailed = errors.some((error) => error.startsWith("stock history by market:"));
  const financialQueryFailed = errors.some((error) => error.startsWith("financial facts by market:"));
  const technicalQueryFailed = errors.some((error) => error.startsWith("technical rows by market:"));
  const rows: AuditRow[] = [];

  for (const master of stockMaster) {
    const market = String(master.market); const job = registryByMarket.get(market); const jobId = job ? String(job.id) : "";
    const hist = historyByMarket.get(market); const active = n(master.active);
    const products = hist ? n(hist.products) : stockHistoryQueryFailed ? n(master.backfill_flag) : 0;
    const lifecycle = jobId ? runFields(jobId, runMaps, checkpointMap, lockMap, failureMap) : runFields("__none__", runMaps, checkpointMap, lockMap, failureMap);
    const schedulerEnabled = Boolean(job?.schedulerEnabled); const delay = nullableNumber(job?.stabilizationDelayMinutes);
    rows.push(baseRow({
      category: "Global Stocks", subcategory: market, providerSource: "YAHOO_CHART",
      availabilityStatus: availability(n(master.universe), hist ? n(hist.rows) : products, schedulerEnabled, products < active),
      universeCount: n(master.universe), activeCount: active, mappedCount: n(master.universe) - n(master.missing_yahoo),
      historicalExpectedCount: active, historicalCompletedCount: products, historicalCoveragePercent: pct(products, active), historicalRowCount: hist ? n(hist.rows) : null,
      earliestDatabaseDate: day(hist?.earliest), latestDatabaseDate: day(master.latest_date ?? hist?.latest),
      latestProviderDate: lifecycle.latestProviderDate, incrementalExpectedCount: active,
      incrementalAttempted: lifecycle.incrementalAttempted, incrementalCompleted: lifecycle.incrementalCompleted, incrementalFailed: lifecycle.incrementalFailed,
      incrementalCoveragePercent: pct(lifecycle.incrementalCompleted, active), noUpdateCount: lifecycle.noUpdateCount, noDataCount: lifecycle.noDataCount,
      staleCount: lifecycle.staleCount, retryQueueCount: lifecycle.retryQueueCount, retryRecoveredCount: lifecycle.retryRecoveredCount,
      permanentFailureCount: lifecycle.permanentFailureCount, lastSuccessfulRun: lifecycle.lastSuccessfulRun, currentRunStatus: lifecycle.currentRunStatus,
      currentCheckpoint: lifecycle.currentCheckpoint, activeLock: lifecycle.activeLock, lastHeartbeat: lifecycle.lastHeartbeat,
      schedulerEnabled, schedulerRule: schedulerEnabled ? `Exchange close ${String((job?.regularSession as Record<string, unknown>)?.close ?? "UNKNOWN")} + ${delay ?? "?"}m; Railway poll ${registry.pollIntervalMinutes}m` : "NOT_CONFIGURED",
      schedulerTimezone: String(job?.timezone ?? "NOT_CONFIGURED"), updateFrequency: "Each exchange trading day after provider final candle",
      validationStatus: lifecycle.validationStatus, productionStatus: production(n(master.universe), hist ? n(hist.rows) : products, schedulerEnabled),
      mainBlockingIssue: !schedulerEnabled ? "No production exchange scheduler" : stockHistoryQueryFailed ? "Exact stock_history row aggregation exceeded production statement timeout; product coverage uses stocks.history_backfilled_at" : products < active ? `${active - products} active stocks have no historical rows` : lifecycle.validationStatus === "FAIL" ? "Latest run validation failed" : "None evidenced",
      details: { inactive: n(master.inactive), delisted: n(master.delisted), missingYahooSymbol: n(master.missing_yahoo), missingOfficialIdentifier: "NOT_MODELED", historyBackfilledFlag: n(master.backfill_flag), exactHistoryRows: hist ? n(hist.rows) : "UNKNOWN_STATEMENT_TIMEOUT", completeOhlcvRows: hist ? n(hist.complete_ohlcv) : null, yahooRows: hist ? n(hist.yahoo_rows) : null, ...lifecycle, runEvidence: lifecycle.runEvidence },
    }));

    const fin = financialByMarket.get(market);
    rows.push(baseRow({
      category: "Financial Statements", subcategory: market, providerSource: String(fin?.sources ?? (market === "TWSE" || market === "TPEx" ? "MOPS" : market === "NASDAQ" || market === "NYSE" || market === "AMEX" ? "SEC EDGAR" : "UNCONFIRMED")),
      availabilityStatus: fin && n(fin.rows) > 0 ? (n(fin.stocks) === active ? "AVAILABLE_AND_INGESTED" : "PARTIALLY_AVAILABLE") : financialQueryFailed ? "PARTIALLY_AVAILABLE" : market === "TWSE" || market === "TPEx" || ["NASDAQ","NYSE","AMEX"].includes(market) ? "AVAILABLE_NOT_CONNECTED" : "SOURCE_RESEARCH_REQUIRED",
      universeCount: n(master.universe), activeCount: active, mappedCount: fin ? n(fin.stocks) : null, historicalExpectedCount: active,
      historicalCompletedCount: fin ? n(fin.stocks) : null, historicalCoveragePercent: fin ? pct(n(fin.stocks), active) : null, historicalRowCount: fin ? n(fin.rows) : null,
      earliestDatabaseDate: day(fin?.earliest), latestDatabaseDate: day(fin?.latest), incrementalExpectedCount: active,
      schedulerEnabled: false, schedulerRule: "No independent filing-triggered production scheduler evidenced", schedulerTimezone: "Provider publication time",
      updateFrequency: "Filing publication", validationStatus: "NO_PRODUCTION_VALIDATION_LEDGER", productionStatus: fin && n(fin.rows) > 0 || financialQueryFailed ? "PARTIAL" : "NOT_STARTED",
      mainBlockingIssue: fin && n(fin.rows) > 0 ? `${active - n(fin.stocks)} active stocks have no financial facts; no production incremental ledger` : financialQueryFailed ? "Exact per-market financial aggregation exceeded production statement timeout" : "No ingested financial facts for this market",
      details: fin ?? { rows: "UNKNOWN_STATEMENT_TIMEOUT", stocks: "UNKNOWN_STATEMENT_TIMEOUT" },
    }));

    rows.push(baseRow({
      category: "Corporate Actions", subcategory: market, providerSource: "NOT_MODELED_FOR_STOCKS",
      availabilityStatus: "SOURCE_RESEARCH_REQUIRED", universeCount: n(master.universe), activeCount: active, mappedCount: 0,
      historicalExpectedCount: active, historicalCompletedCount: 0, historicalCoveragePercent: pct(0, active), historicalRowCount: 0,
      incrementalExpectedCount: active, incrementalAttempted: 0, incrementalCompleted: 0, incrementalFailed: 0, incrementalCoveragePercent: pct(0, active),
      schedulerEnabled: false, updateFrequency: "Announcement-triggered", validationStatus: "NOT_RUN", productionStatus: "NOT_STARTED",
      mainBlockingIssue: "No stock corporate-action table or production ingestion ledger; adjusted close is not an event ledger",
      details: { supportedEvents: [], schemaEvidence: "distributions links ETF/Fund/Asset only" },
    }));

    const tech = technicalByMarket.get(market); const ratio = ratioByMarket.get(market); const derivedStocks = Math.max(n(tech?.stocks), n(ratio?.stocks));
    rows.push(baseRow({
      category: "Derived Metrics", subcategory: market, providerSource: "SMARTFUND_DERIVED + source financial facts",
      availabilityStatus: derivedStocks > 0 ? "PARTIALLY_AVAILABLE" : "AVAILABLE_NOT_CONNECTED", universeCount: n(master.universe), activeCount: active,
      mappedCount: derivedStocks, historicalExpectedCount: active, historicalCompletedCount: derivedStocks, historicalCoveragePercent: pct(derivedStocks, active),
      historicalRowCount: n(tech?.rows) + n(ratio?.rows), earliestDatabaseDate: day(tech?.earliest ?? ratio?.earliest), latestDatabaseDate: day(tech?.latest ?? ratio?.latest),
      incrementalExpectedCount: active, schedulerEnabled: false, schedulerRule: "No production derived-metric scheduler evidenced", schedulerTimezone: "N/A",
      updateFrequency: "After price/filing updates", validationStatus: "NO_POINT_IN_TIME_PRODUCTION_VALIDATION", productionStatus: derivedStocks > 0 ? "PARTIAL" : "PROTOTYPE",
      mainBlockingIssue: technicalQueryFailed ? "Technical per-market aggregation timed out; reported derived count is a lower bound from financial-ratio facts" : derivedStocks < active ? `${active - derivedStocks} active stocks lack technical/derived rows` : "No production incremental ledger",
      details: { technical: tech ?? { status: "UNKNOWN_STATEMENT_TIMEOUT" }, financialRatios: ratio ?? {}, coverageIsLowerBound: technicalQueryFailed },
    }));
  }

  const etfStats = await query<Record<string, unknown>>("ETF regional stats", `WITH tagged AS (SELECT CASE WHEN region='TW' OR currency='TWD' OR exchange IN ('TWSE','TPEx') THEN 'Taiwan ETF' WHEN region='US' THEN 'United States ETF' WHEN region='JP' OR exchange='Tokyo' THEN 'Japan ETF' WHEN region='HK' OR exchange='HKSE' THEN 'Hong Kong ETF' WHEN region='CA' THEN 'Canada ETF' WHEN region='AU' THEN 'Australia ETF' WHEN region IN ('GB','DE','FR','ES','IT','NL','EU') OR exchange IN ('LSE','Cboe UK','IOB','Aquis AQSE') THEN 'Europe ETF' ELSE 'Other Global ETF' END subcategory,e.* FROM etfs e), hist AS (SELECT t.subcategory,COUNT(*)::bigint rows,COUNT(DISTINCT h.etf_id)::int products,MIN(h.date) earliest,MAX(h.date) latest,COUNT(*) FILTER(WHERE h.price IS NOT NULL)::bigint price_rows,COUNT(*) FILTER(WHERE h.nav IS NOT NULL)::bigint nav_rows FROM tagged t LEFT JOIN etf_history h ON h.etf_id=t.id GROUP BY t.subcategory), master AS (SELECT subcategory,COUNT(*)::int universe,COUNT(*) FILTER(WHERE is_active)::int active,COUNT(*) FILTER(WHERE code IS NOT NULL AND code<>'')::int mapped,string_agg(DISTINCT COALESCE(data_provider,provider,'NULL'),', ') sources FROM tagged GROUP BY subcategory) SELECT master.*,hist.rows,hist.products,hist.earliest,hist.latest,hist.price_rows,hist.nav_rows FROM master JOIN hist USING(subcategory) ORDER BY subcategory`);
  const etfRelations = await query<Record<string, unknown>>("ETF holdings/distributions", "SELECT COUNT(DISTINCT e.id) FILTER(WHERE h.id IS NOT NULL)::int holding_products,COUNT(h.*)::bigint holding_rows,COUNT(DISTINCT e.id) FILTER(WHERE d.id IS NOT NULL)::int distribution_products,COUNT(d.*)::bigint distribution_rows FROM etfs e LEFT JOIN holdings h ON h.etf_id=e.id LEFT JOIN distributions d ON d.etf_id=e.id");
  const globalEtfLifecycle = runFields("global_etf-production-daily", runMaps, checkpointMap, lockMap, failureMap);
  for (const stat of etfStats) {
    const isTaiwan = stat.subcategory === "Taiwan ETF"; const active = n(stat.active); const products = n(stat.products); const scheduled = !isTaiwan;
    rows.push(baseRow({
      category: "ETF", subcategory: String(stat.subcategory), providerSource: String(stat.sources ?? "UNCONFIRMED"),
      availabilityStatus: availability(n(stat.universe), n(stat.rows), scheduled, products < active), universeCount: n(stat.universe), activeCount: active, mappedCount: n(stat.mapped),
      historicalExpectedCount: active, historicalCompletedCount: products, historicalCoveragePercent: pct(products, active), historicalRowCount: n(stat.rows),
      earliestDatabaseDate: day(stat.earliest), latestDatabaseDate: day(stat.latest),
      incrementalExpectedCount: null, incrementalAttempted: null, incrementalCompleted: null,
      incrementalFailed: null, incrementalCoveragePercent: null,
      schedulerEnabled: scheduled, schedulerRule: scheduled ? "Railway cron */5; shared Global ETF resumable slices" : "CONFIG_ONLY in data-daily-schedule.json; not Railway production job",
      schedulerTimezone: scheduled ? "America/New_York provider day" : "Asia/Taipei config", updateFrequency: "Exchange/provider latest available",
      validationStatus: scheduled ? globalEtfLifecycle.validationStatus : "NO_PRODUCTION_RUN_LEDGER", productionStatus: production(n(stat.universe), n(stat.rows), scheduled),
      mainBlockingIssue: products < active ? `${active - products} active ETFs have no history` : isTaiwan ? "Taiwan ETF has no Railway production daily lifecycle evidence" : "Regional daily counts are not isolated inside the combined Global ETF run",
      details: { priceRows: n(stat.price_rows), navRows: n(stat.nav_rows), holdings: etfRelations[0] ?? {}, rowLevelProvenance: "NOT_MODELED_IN_ETF_HISTORY" },
    }));
  }
  rows.push(baseRow({
    category: "ETF", subcategory: "Global ETF Production Daily Lifecycle", providerSource: "YAHOO_CHART",
    availabilityStatus: "PARTIALLY_AVAILABLE", universeCount: null, activeCount: null, mappedCount: null,
    historicalExpectedCount: null, historicalCompletedCount: null, historicalRowCount: null,
    latestProviderDate: globalEtfLifecycle.latestProviderDate, incrementalExpectedCount: 12453,
    incrementalAttempted: globalEtfLifecycle.incrementalAttempted, incrementalCompleted: globalEtfLifecycle.incrementalCompleted,
    incrementalFailed: globalEtfLifecycle.incrementalFailed, incrementalCoveragePercent: pct(globalEtfLifecycle.incrementalCompleted, 12453),
    noUpdateCount: globalEtfLifecycle.noUpdateCount, noDataCount: globalEtfLifecycle.noDataCount,
    staleCount: globalEtfLifecycle.staleCount, retryQueueCount: globalEtfLifecycle.retryQueueCount,
    retryRecoveredCount: globalEtfLifecycle.retryRecoveredCount, permanentFailureCount: globalEtfLifecycle.permanentFailureCount,
    lastSuccessfulRun: globalEtfLifecycle.lastSuccessfulRun, currentRunStatus: globalEtfLifecycle.currentRunStatus,
    currentCheckpoint: globalEtfLifecycle.currentCheckpoint, activeLock: globalEtfLifecycle.activeLock,
    lastHeartbeat: globalEtfLifecycle.lastHeartbeat, schedulerEnabled: true,
    schedulerRule: "Railway cron */5; resumable slices; combined Global ETF universe", schedulerTimezone: "America/New_York provider day",
    updateFrequency: "Provider latest available", validationStatus: globalEtfLifecycle.validationStatus,
    productionStatus: "PARTIAL", mainBlockingIssue: "Production run is combined; regional incremental counts are not isolated",
    details: globalEtfLifecycle,
  }));

  const fundStats = await query<Record<string, unknown>>("fund aggregate", "SELECT COUNT(*)::int universe,COUNT(*) FILTER(WHERE is_active)::int active,COUNT(*) FILTER(WHERE COALESCE(code,isin,'')<>'')::int mapped,COUNT(*) FILTER(WHERE latest_nav_date IS NOT NULL)::int latest_mapped,string_agg(DISTINCT COALESCE(data_provider,'NULL'),', ') sources FROM funds");
  const fundHist = await query<Record<string, unknown>>("fund history aggregate", "SELECT COUNT(*)::bigint rows,COUNT(DISTINCT fund_id)::int products,MIN(date) earliest,MAX(date) latest,COUNT(*) FILTER(WHERE nav IS NOT NULL)::bigint nav_rows FROM fund_history");
  const fundRel = await query<Record<string, unknown>>("fund relations", "SELECT COUNT(DISTINCT f.id) FILTER(WHERE h.id IS NOT NULL)::int holding_products,COUNT(h.*)::bigint holding_rows,COUNT(DISTINCT f.id) FILTER(WHERE d.id IS NOT NULL)::int distribution_products,COUNT(d.*)::bigint distribution_rows FROM funds f LEFT JOIN holdings h ON h.fund_id=f.id LEFT JOIN distributions d ON d.fund_id=f.id");
  const fs = fundStats[0] ?? {}; const fh = fundHist[0] ?? {}; const fundUniverse = n(fs.universe); const fundProducts = n(fh.products);
  rows.push(baseRow({ category: "Fund", subcategory: "All Funds (domestic/offshore classification unavailable)", providerSource: String(fs.sources ?? "UNCONFIRMED"), availabilityStatus: availability(fundUniverse, n(fh.rows), false, fundProducts < fundUniverse), universeCount: fundUniverse, activeCount: n(fs.active), mappedCount: n(fs.mapped), historicalExpectedCount: n(fs.active), historicalCompletedCount: fundProducts, historicalCoveragePercent: pct(fundProducts, n(fs.active)), historicalRowCount: n(fh.rows), earliestDatabaseDate: day(fh.earliest), latestDatabaseDate: day(fh.latest), incrementalExpectedCount: n(fs.active), incrementalCompleted: n(fs.latest_mapped), incrementalCoveragePercent: pct(n(fs.latest_mapped), n(fs.active)), schedulerEnabled: false, schedulerRule: "MoneyDJ job is CONFIG_ONLY; not called by Railway production cron", schedulerTimezone: "Asia/Taipei config", updateFrequency: "Provider NAV publication", validationStatus: "NO_PRODUCTION_RUN_LEDGER", productionStatus: n(fh.rows) > 0 ? "PARTIAL" : "PROTOTYPE", mainBlockingIssue: `Fund master lacks domicile/share-class fields needed to split Taiwan/offshore/US/UCITS/Japan; ${fundUniverse - fundProducts} funds have no history`, details: { navRows: n(fh.nav_rows), latestNavProducts: n(fs.latest_mapped), holdings: fundRel[0] ?? {}, rowLevelProvenance: "NOT_MODELED_IN_FUND_HISTORY" } }));
  for (const subcategory of ["Taiwan Domestic Funds", "Offshore Funds", "US Mutual Funds", "Europe UCITS", "Japan Funds"]) rows.push(baseRow({ category: "Fund", subcategory, providerSource: "UNCLASSIFIABLE_FROM_CURRENT_MASTER", availabilityStatus: "PARTIALLY_AVAILABLE", universeCount: null, historicalCompletedCount: null, historicalRowCount: null, schedulerEnabled: false, productionStatus: "PARTIAL", mainBlockingIssue: "Current fund master has no reliable domicile/share-class classification; aggregate data exists but cannot be truthfully split" }));

  const marketAssets = await query<Record<string, unknown>>("market asset aggregate", `WITH tagged AS (SELECT CASE WHEN asset_type::text='COMMODITY' AND lower(COALESCE(symbol,'')||' '||COALESCE(name,'')||' '||COALESCE(category,'')) ~ '(gold|silver|platinum|palladium)' THEN 'Precious Metals' WHEN asset_type::text='COMMODITY' AND lower(COALESCE(symbol,'')||' '||COALESCE(name,'')||' '||COALESCE(category,'')) ~ '(oil|crude|brent|wti|natural gas|gasoline|heating|coal|lng|uranium)' THEN 'Energy' WHEN asset_type::text='COMMODITY' THEN 'Commodities' WHEN asset_type::text='FOREX' THEN 'FX' WHEN asset_type::text='CRYPTO' THEN 'Crypto' WHEN asset_type::text='INDEX' THEN 'Stock Indices' WHEN asset_type::text='VOLATILITY' THEN 'Volatility' WHEN asset_type::text='BOND' THEN 'Government Yields' ELSE asset_type::text END subcategory,m.* FROM market_master m), hist AS (SELECT t.subcategory,COUNT(h.*)::bigint rows,COUNT(DISTINCT h.symbol)::int products,MIN(h.date) earliest,MAX(h.date) latest FROM tagged t LEFT JOIN market_history h ON h.symbol=t.symbol GROUP BY t.subcategory), master AS (SELECT subcategory,COUNT(*)::int universe,COUNT(*) FILTER(WHERE is_active)::int active,string_agg(DISTINCT COALESCE(provider,'NULL'),', ') sources FROM tagged GROUP BY subcategory) SELECT master.*,hist.rows,hist.products,hist.earliest,hist.latest FROM master JOIN hist USING(subcategory) ORDER BY subcategory`);
  const assetJob: Record<string,string> = { "Stock Indices": "market_index-production-daily", Volatility: "volatility-production-daily", "Government Yields": "bond_yield-production-daily" };
  for (const stat of marketAssets) {
    const sub = String(stat.subcategory); const jobId = assetJob[sub]; const lifecycle = runFields(jobId ?? "__none__", runMaps, checkpointMap, lockMap, failureMap);
    const scheduled = Boolean(jobId); const active = n(stat.active); const products = n(stat.products);
    rows.push(baseRow({ category: sub, subcategory: sub === "Commodities" ? "Industrial/Agriculture/Livestock not normalized" : "All configured series", providerSource: String(stat.sources ?? "UNCONFIRMED"), availabilityStatus: availability(n(stat.universe), n(stat.rows), scheduled, products < active), universeCount: n(stat.universe), activeCount: active, mappedCount: n(stat.universe), historicalExpectedCount: active, historicalCompletedCount: products, historicalCoveragePercent: pct(products, active), historicalRowCount: n(stat.rows), earliestDatabaseDate: day(stat.earliest), latestDatabaseDate: day(stat.latest), latestProviderDate: lifecycle.latestProviderDate, incrementalExpectedCount: active, incrementalAttempted: lifecycle.incrementalAttempted, incrementalCompleted: lifecycle.incrementalCompleted, incrementalFailed: lifecycle.incrementalFailed, incrementalCoveragePercent: pct(lifecycle.incrementalCompleted, active), noUpdateCount: lifecycle.noUpdateCount, noDataCount: lifecycle.noDataCount, staleCount: lifecycle.staleCount, retryQueueCount: lifecycle.retryQueueCount, retryRecoveredCount: lifecycle.retryRecoveredCount, permanentFailureCount: lifecycle.permanentFailureCount, lastSuccessfulRun: lifecycle.lastSuccessfulRun, currentRunStatus: lifecycle.currentRunStatus, currentCheckpoint: lifecycle.currentCheckpoint, activeLock: lifecycle.activeLock, lastHeartbeat: lifecycle.lastHeartbeat, schedulerEnabled: scheduled, schedulerRule: scheduled ? "Railway cron */5; provider-latest adapter" : "Provider registry exists, but runner does not dispatch this asset class", schedulerTimezone: scheduled ? "America/New_York provider day" : "NOT_CONFIGURED", updateFrequency: sub === "Crypto" ? "24/7 required; current scheduler absent" : sub === "FX" ? "Daily/intraday required; current scheduler absent" : "Provider/market settlement", validationStatus: lifecycle.validationStatus, productionStatus: production(n(stat.universe), n(stat.rows), scheduled), mainBlockingIssue: !scheduled ? "Historical data exists, but no Railway production incremental job is connected" : products < active ? `${active - products} configured series have no history` : "None evidenced", details: { rowLevelProvenance: "NOT_MODELED_IN_MARKET_HISTORY", ...lifecycle } }));
  }

  const indexStats = await query<Record<string, unknown>>("market indexes", "SELECT COUNT(*)::int universe,COUNT(*) FILTER(WHERE is_active)::int active,COUNT(*) FILTER(WHERE yahoo_symbol IS NOT NULL)::int mapped,string_agg(DISTINCT provider,', ') sources FROM market_indexes");
  const indexHist = await query<Record<string, unknown>>("index history", "SELECT COUNT(*)::bigint rows,COUNT(DISTINCT index_id)::int products,MIN(date) earliest,MAX(date) latest,COUNT(*) FILTER(WHERE provider='YAHOO')::bigint yahoo_rows FROM index_history");
  if (indexStats.length) rows.push(baseRow({ category: "Stock Indices", subcategory: "market_indexes canonical table", providerSource: String(indexStats[0].sources ?? "UNCONFIRMED"), availabilityStatus: availability(n(indexStats[0].universe), n(indexHist[0]?.rows), false, n(indexHist[0]?.products) < n(indexStats[0].active)), universeCount: n(indexStats[0].universe), activeCount: n(indexStats[0].active), mappedCount: n(indexStats[0].mapped), historicalExpectedCount: n(indexStats[0].active), historicalCompletedCount: n(indexHist[0]?.products), historicalCoveragePercent: pct(n(indexHist[0]?.products), n(indexStats[0].active)), historicalRowCount: n(indexHist[0]?.rows), earliestDatabaseDate: day(indexHist[0]?.earliest), latestDatabaseDate: day(indexHist[0]?.latest), schedulerEnabled: false, schedulerRule: "Separate canonical index table is not connected to Railway asset runner", updateFrequency: "Exchange close", validationStatus: "NO_PRODUCTION_LEDGER", productionStatus: n(indexHist[0]?.rows)>0 ? "PARTIAL":"PROTOTYPE", mainBlockingIssue: "Duplicate index storage paths (market_master and market_indexes) are not reconciled", details: indexHist[0] ?? {} }));

  const econMaster = await query<Record<string, unknown>>("economic master", "SELECT COUNT(*)::int universe,COUNT(*) FILTER(WHERE enabled)::int active,COUNT(DISTINCT provider)::int providers,string_agg(DISTINCT provider,', ' ORDER BY provider) sources FROM economic_series");
  const econHist = await query<Record<string, unknown>>("economic history", "SELECT COUNT(*)::bigint rows,COUNT(DISTINCT series_id)::int products,MIN(date) earliest,MAX(date) latest,COUNT(*) FILTER(WHERE revised IS NOT NULL)::bigint revised_rows,COUNT(*) FILTER(WHERE source_url IS NOT NULL AND raw_checksum IS NOT NULL)::bigint provenance_rows FROM economic_values");
  const macroLifecycle = runFields("macro-production-daily", runMaps, checkpointMap, lockMap, failureMap); const em=econMaster[0]??{}; const eh=econHist[0]??{};
  rows.push(baseRow({ category: "Economic Data", subcategory: "All Economic Series", providerSource: String(em.sources ?? "UNCONFIRMED"), availabilityStatus: availability(n(em.universe), n(eh.rows), true, n(eh.products)<n(em.active)), universeCount:n(em.universe),activeCount:n(em.active),mappedCount:n(em.universe),historicalExpectedCount:n(em.active),historicalCompletedCount:n(eh.products),historicalCoveragePercent:pct(n(eh.products),n(em.active)),historicalRowCount:n(eh.rows),earliestDatabaseDate:day(eh.earliest),latestDatabaseDate:day(eh.latest),latestProviderDate:macroLifecycle.latestProviderDate,incrementalExpectedCount:n(em.active),incrementalAttempted:macroLifecycle.incrementalAttempted,incrementalCompleted:macroLifecycle.incrementalCompleted,incrementalFailed:macroLifecycle.incrementalFailed,incrementalCoveragePercent:pct(macroLifecycle.incrementalCompleted,n(em.active)),noUpdateCount:macroLifecycle.noUpdateCount,noDataCount:macroLifecycle.noDataCount,staleCount:macroLifecycle.staleCount,retryQueueCount:macroLifecycle.retryQueueCount,retryRecoveredCount:macroLifecycle.retryRecoveredCount,permanentFailureCount:macroLifecycle.permanentFailureCount,lastSuccessfulRun:macroLifecycle.lastSuccessfulRun,currentRunStatus:macroLifecycle.currentRunStatus,currentCheckpoint:macroLifecycle.currentCheckpoint,activeLock:macroLifecycle.activeLock,lastHeartbeat:macroLifecycle.lastHeartbeat,schedulerEnabled:true,schedulerRule:"Railway cron */5; adapters currently executable for FRED/ECB",schedulerTimezone:"Provider publication schedule",updateFrequency:"Official provider release",validationStatus:macroLifecycle.validationStatus,productionStatus:production(n(em.universe),n(eh.rows),true),mainBlockingIssue:n(eh.products)<n(em.active)?`${n(em.active)-n(eh.products)} enabled series have no observations; IMF/OECD/World Bank are not all incremental adapters`:"Vintage history is not preserved by unique(series,date)",details:{providers:n(em.providers),revisedRows:n(eh.revised_rows),provenanceRows:n(eh.provenance_rows),vintageDataPreserved:false,...macroLifecycle} }));
  const econProvider = await query<Record<string, unknown>>("economic provider detail", "SELECT s.provider,COUNT(DISTINCT s.id)::int universe,COUNT(DISTINCT v.series_id)::int products,COUNT(v.*)::bigint rows,MIN(v.date) earliest,MAX(v.date) latest,COUNT(*) FILTER(WHERE s.enabled)::int active,string_agg(DISTINCT s.frequency::text,', ') frequencies FROM economic_series s LEFT JOIN economic_values v ON v.series_id=s.id GROUP BY s.provider ORDER BY s.provider");
  for (const stat of econProvider) rows.push(baseRow({ category:"Economic Data",subcategory:`Provider: ${String(stat.provider)}`,providerSource:String(stat.provider),availabilityStatus:n(stat.rows)>0?"PARTIALLY_AVAILABLE":"AVAILABLE_NOT_CONNECTED",universeCount:n(stat.universe),activeCount:n(stat.active),mappedCount:n(stat.universe),historicalExpectedCount:n(stat.active),historicalCompletedCount:n(stat.products),historicalCoveragePercent:pct(n(stat.products),n(stat.active)),historicalRowCount:n(stat.rows),earliestDatabaseDate:day(stat.earliest),latestDatabaseDate:day(stat.latest),schedulerEnabled:["FRED","ECB"].includes(String(stat.provider)),schedulerRule:["FRED","ECB"].includes(String(stat.provider))?"Railway macro adapter":"Backfill/config only; not verified in Railway incremental runner",schedulerTimezone:"Provider release",updateFrequency:String(stat.frequencies??"UNKNOWN"),validationStatus:["FRED","ECB"].includes(String(stat.provider))?macroLifecycle.validationStatus:"NO_INCREMENTAL_VALIDATION",productionStatus:["FRED","ECB"].includes(String(stat.provider))&&n(stat.rows)>0?"PRODUCTION":"PARTIAL",mainBlockingIssue:["FRED","ECB"].includes(String(stat.provider))?"None evidenced":"Provider is present in database but current production macro registry/adapter execution is incomplete" }));

  const central = await query<Record<string, unknown>>("central bank subset", "SELECT COUNT(DISTINCT s.id)::int universe,COUNT(DISTINCT v.series_id)::int products,COUNT(v.*)::bigint rows,MIN(v.date) earliest,MAX(v.date) latest,string_agg(DISTINCT s.provider,', ') sources FROM economic_series s LEFT JOIN economic_values v ON v.series_id=s.id WHERE s.category ILIKE '%Interest%' OR s.name ~* '(policy rate|federal funds|deposit facility|main refinancing|central bank|balance sheet)'");
  const cb=central[0]??{}; rows.push(baseRow({category:"Central Bank Data",subcategory:"Policy rates / balance-sheet-like series",providerSource:String(cb.sources??"UNCONFIRMED"),availabilityStatus:n(cb.rows)>0?"PARTIALLY_AVAILABLE":"SOURCE_RESEARCH_REQUIRED",universeCount:n(cb.universe),activeCount:n(cb.universe),mappedCount:n(cb.universe),historicalExpectedCount:n(cb.universe),historicalCompletedCount:n(cb.products),historicalCoveragePercent:pct(n(cb.products),n(cb.universe)),historicalRowCount:n(cb.rows),earliestDatabaseDate:day(cb.earliest),latestDatabaseDate:day(cb.latest),schedulerEnabled:true,schedulerRule:"Through macro FRED/ECB adapters only",schedulerTimezone:"Provider release",updateFrequency:"Official release",validationStatus:macroLifecycle.validationStatus,productionStatus:n(cb.rows)>0?"PARTIAL":"NOT_STARTED",mainBlockingIssue:"No complete per-central-bank registry for BOJ/BOE/BOC/RBA/CBC/PBOC/BOK"}));

  const assets = await query<Record<string, unknown>>("asset classes", "SELECT asset_type::text asset_type,COUNT(*)::int universe,COUNT(*) FILTER(WHERE is_active)::int active,COUNT(DISTINCT a.id) FILTER(WHERE EXISTS(SELECT 1 FROM asset_performances p WHERE p.asset_id=a.id))::int products,string_agg(DISTINCT COALESCE(provider,'NULL'),', ') sources FROM assets a GROUP BY asset_type ORDER BY asset_type");
  const assetHist = await query<Record<string, unknown>>("asset history", "SELECT a.asset_type::text asset_type,COUNT(p.*)::bigint rows,MIN(p.date) earliest,MAX(p.date) latest FROM assets a LEFT JOIN asset_performances p ON p.asset_id=a.id GROUP BY a.asset_type");
  const assetHistMap=new Map(assetHist.map((x)=>[String(x.asset_type),x]));
  for(const stat of assets){const hist=assetHistMap.get(String(stat.asset_type)); rows.push(baseRow({category:String(stat.asset_type)==="REIT"?"REIT / Real Estate":`Other Asset: ${String(stat.asset_type)}`,subcategory:"assets + asset_performances",providerSource:String(stat.sources??"UNCONFIRMED"),availabilityStatus:availability(n(stat.universe),n(hist?.rows),false,n(stat.products)<n(stat.active)),universeCount:n(stat.universe),activeCount:n(stat.active),mappedCount:n(stat.universe),historicalExpectedCount:n(stat.active),historicalCompletedCount:n(stat.products),historicalCoveragePercent:pct(n(stat.products),n(stat.active)),historicalRowCount:n(hist?.rows),earliestDatabaseDate:day(hist?.earliest),latestDatabaseDate:day(hist?.latest),schedulerEnabled:false,updateFrequency:"Provider-specific",productionStatus:n(hist?.rows)>0?"PARTIAL":"PROTOTYPE",mainBlockingIssue:"No dedicated production lifecycle; row-level provenance is not modeled"}));}
  const insurance = await query<Record<string, unknown>>("insurance", "SELECT COUNT(*)::int universe,COUNT(*) FILTER(WHERE is_active)::int active,COUNT(DISTINCT p.id) FILTER(WHERE EXISTS(SELECT 1 FROM insurance_history h WHERE h.product_id=p.id))::int products FROM insurance_products p");
  const insuranceHist=await query<Record<string,unknown>>("insurance history","SELECT COUNT(*)::bigint rows,MIN(date) earliest,MAX(date) latest FROM insurance_history");
  const ins=insurance[0]??{},ih=insuranceHist[0]??{}; rows.push(baseRow({category:"Alternative Data",subcategory:"Insurance Products",providerSource:"Product-specific sources not normalized",availabilityStatus:availability(n(ins.universe),n(ih.rows),false,n(ins.products)<n(ins.active)),universeCount:n(ins.universe),activeCount:n(ins.active),mappedCount:n(ins.universe),historicalExpectedCount:n(ins.active),historicalCompletedCount:n(ins.products),historicalCoveragePercent:pct(n(ins.products),n(ins.active)),historicalRowCount:n(ih.rows),earliestDatabaseDate:day(ih.earliest),latestDatabaseDate:day(ih.latest),schedulerEnabled:false,productionStatus:n(ih.rows)>0?"PARTIAL":"PROTOTYPE",mainBlockingIssue:"No production scheduler, checkpoint, failure queue, or row-level provenance"}));

  for (const item of [
    ["Bonds","Individual Government/Corporate/Municipal/Agency/Convertible Bonds"],
    ["Futures / Options","Futures contracts / options chains / implied volatility / open interest"],
    ["Alternative Data","CDS / swaps / credit ratings / freight / semiconductor pricing / carbon markets"],
    ["Alternative Data","Fund flows / ETF flows / short interest / insider / institutional holdings / analyst estimates"],
    ["Alternative Data","Earnings/dividend/economic/IPO/delisting/corporate-action calendars"],
    ["REIT / Real Estate","Property indices / cap rates / rental indices / private-market proxies"],
  ] as const) rows.push(baseRow({category:item[0],subcategory:item[1],providerSource:"NO_CONFIRMED_PRODUCTION_SOURCE",availabilityStatus:"SOURCE_RESEARCH_REQUIRED",universeCount:0,activeCount:0,mappedCount:0,historicalExpectedCount:0,historicalCompletedCount:0,historicalCoveragePercent:0,historicalRowCount:0,schedulerEnabled:false,productionStatus:"NOT_STARTED",mainBlockingIssue:"No canonical production table and no verified ingestion evidence"}));

  const endCounts=await tableCounts();
  const tableDeltas=Object.fromEntries(Object.keys(endCounts).map((key)=>[key,endCounts[key]-(startCounts[key]??0)]));
  let localWorkers: Array<Record<string,unknown>>=[];
  try {
    const output=execFileSync("powershell",["-NoProfile","-Command",`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'scripts[\\\\/]data|backfill|historical|daily' -and $_.CommandLine -notmatch 'audit-global-all-data-status' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`],{encoding:"utf8",timeout:15000}).trim();
    if(output){const parsed=JSON.parse(output);localWorkers=Array.isArray(parsed)?parsed:[parsed];}
  } catch(error){errors.push(`local worker scan: ${error instanceof Error?error.message:String(error)}`);}
  const currentRuns=await query<RunRow>("current active runs", "SELECT id,job_id,run_type,status,started_at,completed_at,universe_count,attempted,completed,failed,no_update_count,permanent_unavailable_count,retryable_failure_count,latest_trading_date,target_trade_date,provider_latest_date,validation_status,validation_details,exit_code,error FROM production_scheduler_runs WHERE status IN ('IN_PROGRESS','RUNNING','PAUSE_REQUESTED') ORDER BY started_at DESC");
  const currentCheckpoints=await query<Record<string,unknown>>("current checkpoints", "SELECT DISTINCT ON (job_id) job_id,last_symbol,processed,succeeded,failed,target_trade_date,run_type,updated_at FROM production_scheduler_checkpoints ORDER BY job_id,updated_at DESC");
  const currentLocks=await query<Record<string,unknown>>("current locks", "SELECT job_id,owner,expires_at,updated_at FROM production_scheduler_locks WHERE expires_at>NOW() AND updated_at>NOW()-INTERVAL '10 minutes'");
  const currentCheckpointMap=new Map(currentCheckpoints.map((row)=>[String(row.job_id),row]));
  const currentLockMap=new Map(currentLocks.map((row)=>[String(row.job_id),row]));
  const activeWorkers=currentRuns.map((run)=>{const elapsedMinutes=Math.max(0.01,(Date.now()-new Date(run.started_at).getTime())/60000);const rate=run.attempted/elapsedMinutes;const remaining=Math.max(0,run.universe_count-run.attempted);return {runId:run.id,jobId:run.job_id,runType:run.run_type,status:run.status,universe:run.universe_count,attempted:run.attempted,completed:run.completed,failed:run.failed,checkpoint:currentCheckpointMap.has(run.job_id)?safeJson(currentCheckpointMap.get(run.job_id)):null,lastHeartbeat:iso(currentLockMap.get(run.job_id)?.updated_at),etaMinutes:rate>0?Number((remaining/rate).toFixed(1)):null};});

  const gaps:Gap[]=[];
  for(const row of rows){
    if((row.universeCount??0)===0)gaps.push({gapType:"A/F",category:row.category,market:row.subcategory,instrument:"All",missingComponent:"Universe / provider",currentCoverage:coverage(row.historicalCompletedCount,row.historicalExpectedCount),blockingReason:row.mainBlockingIssue,existingScript:"None evidenced",existingDataSource:row.providerSource,currentWorkerStatus:row.currentRunStatus,nextExecutableAction:"Confirm source and create canonical universe before ingestion"});
    else if((row.historicalCoveragePercent??100)<100)gaps.push({gapType:"B",category:row.category,market:row.subcategory,instrument:"Universe",missingComponent:"Historical backfill",currentCoverage:coverage(row.historicalCompletedCount,row.historicalExpectedCount),blockingReason:row.mainBlockingIssue,existingScript:"Repository scan required per category",existingDataSource:row.providerSource,currentWorkerStatus:row.currentRunStatus,nextExecutableAction:"Resume existing checkpoint/failure queue; do not restart completed instruments"});
    if(!row.schedulerEnabled)gaps.push({gapType:"C/D",category:row.category,market:row.subcategory,instrument:"Universe",missingComponent:"Incremental scheduler",currentCoverage:coverage(row.incrementalCompleted,row.incrementalExpectedCount),blockingReason:row.mainBlockingIssue,existingScript:"Config/script may exist but no Railway production execution evidenced",existingDataSource:row.providerSource,currentWorkerStatus:row.currentRunStatus,nextExecutableAction:"Connect existing incremental runner to production lifecycle without redoing history"});
    if(row.validationStatus==="FAIL"||row.validationStatus.startsWith("NO_"))gaps.push({gapType:"H",category:row.category,market:row.subcategory,instrument:"Latest run",missingComponent:"Validation",currentCoverage:coverage(row.incrementalCompleted,row.incrementalExpectedCount),blockingReason:row.validationStatus,existingScript:"Existing validation where present",existingDataSource:row.providerSource,currentWorkerStatus:row.currentRunStatus,nextExecutableAction:"Validate current data and preserve successful rows"});
    if(row.category==="Economic Data"&&row.details.vintageDataPreserved===false)gaps.push({gapType:"L",category:row.category,market:row.subcategory,instrument:"Economic observations",missingComponent:"Revision/vintage history",currentCoverage:"Latest value only per series/date",blockingReason:"Unique(series_id,date) overwrites revisions",existingScript:"Macro adapters",existingDataSource:row.providerSource,currentWorkerStatus:row.currentRunStatus,nextExecutableAction:"Add versioned vintage storage without blocking current incremental updates"});
  }

  const summaryRows = rows.filter((row) => {
    if (row.category === "Fund") return row.subcategory.startsWith("All Funds");
    if (row.category === "Stock Indices") return row.subcategory !== "market_indexes canonical table";
    if (row.category === "Economic Data") return row.subcategory === "All Economic Series";
    return true;
  });
  const categorySummary=Object.values(summaryRows.reduce<Record<string,{category:string;universe:number;historicalExpected:number;historicalCompleted:number;historicalRows:number;incrementalExpected:number;incrementalCompleted:number;earliest:string|null;latest:string|null;running:number;failed:number;retry:number;schedulers:number;gaps:Set<string>}>>((acc,row)=>{const current=acc[row.category]??={category:row.category,universe:0,historicalExpected:0,historicalCompleted:0,historicalRows:0,incrementalExpected:0,incrementalCompleted:0,earliest:null,latest:null,running:0,failed:0,retry:0,schedulers:0,gaps:new Set<string>()};current.universe+=row.universeCount??0;current.historicalExpected+=row.historicalExpectedCount??0;current.historicalCompleted+=row.historicalCompletedCount??0;current.historicalRows+=row.historicalRowCount??0;current.incrementalExpected+=row.incrementalExpectedCount??0;current.incrementalCompleted+=row.incrementalCompleted??0;if(row.earliestDatabaseDate&&(!current.earliest||row.earliestDatabaseDate<current.earliest))current.earliest=row.earliestDatabaseDate;if(row.latestDatabaseDate&&(!current.latest||row.latestDatabaseDate>current.latest))current.latest=row.latestDatabaseDate;if(row.currentRunStatus==="RUNNING"||row.activeLock)current.running++;current.failed+=row.incrementalFailed??0;current.retry+=row.retryQueueCount??0;if(row.schedulerEnabled)current.schedulers++;if(row.mainBlockingIssue!=="None evidenced")current.gaps.add(row.mainBlockingIssue);acc[row.category]=current;return acc;},{})).map((value)=>({...value,historicalCoveragePercent:pct(value.historicalCompleted,value.historicalExpected),incrementalCoveragePercent:pct(value.incrementalCompleted,value.incrementalExpected),gaps:[...value.gaps]}));
  if (stockHistoryQueryFailed) {
    const summary = categorySummary.find((item) => item.category === "Global Stocks");
    if (summary) { (summary as Record<string, unknown>).historicalRows = null; (summary as Record<string, unknown>).earliest = null; }
  }
  if (financialQueryFailed) {
    const summary = categorySummary.find((item) => item.category === "Financial Statements");
    if (summary) { (summary as Record<string, unknown>).historicalCompleted = null; (summary as Record<string, unknown>).historicalRows = null; (summary as Record<string, unknown>).historicalCoveragePercent = null; }
  }

  const report={runId,generatedAt:generatedAt.toISOString(),completedAt:new Date().toISOString(),mode:"READ_ONLY_PRODUCTION_AUDIT",productionDatabase:"Supabase via Railway production environment",rows,categorySummary,currentWorkers:{railway:activeWorkers,local:localWorkers},tableCounts:{start:startCounts,end:endCounts,deltaDuringAudit:tableDeltas},gaps,evidence:{productionCron:"*/5 * * * *",stockExchangeRegistry:registry.jobs.length,configuredDailyJobs:dailySchedule.jobs,runLedgerRows:runs.length,checkpointRows:checkpointRows.length,activeLocks:lockRows,queryErrors:errors}};
  const outDir=join(root,"debug","global-data-audit",runId);await mkdir(outDir,{recursive:true});
  const headers=Object.keys(baseRow({category:"",subcategory:""})) as Array<keyof AuditRow>;
  const csv=[headers.join(","),...rows.map((row)=>headers.map((key)=>csvCell(row[key])).join(","))].join("\r\n")+"\r\n";
  await writeFile(join(outDir,"global-data-status.json"),safeJson(report)+"\n","utf8");await writeFile(join(outDir,"global-data-status.csv"),csv,"utf8");
  const summaryLines=categorySummary.map((r)=>`| ${r.category} | ${r.universe} | ${coverage(r.historicalCompleted,r.historicalExpected)} | ${r.historicalRows} | ${r.earliest??"UNKNOWN"} | ${r.latest??"UNKNOWN"} | ${coverage(r.incrementalCompleted,r.incrementalExpected)} | ${r.running?"RUNNING":"IDLE"} | ${r.gaps[0]??"None evidenced"} |`);
  const stockLines=rows.filter((r)=>r.category==="Global Stocks").map((r)=>`| ${r.subcategory} | ${r.universeCount} | ${r.activeCount} | ${coverage(r.historicalCompletedCount,r.historicalExpectedCount)} | ${r.historicalRowCount} | ${r.latestProviderDate??"UNKNOWN"} | ${r.latestDatabaseDate??"UNKNOWN"} | ${coverage(r.incrementalCompleted,r.incrementalExpectedCount)} | ${r.currentRunStatus} | ${r.currentCheckpoint??"NONE"} | ${r.retryQueueCount??"UNKNOWN"} |`);
  const detailLines=rows.map((r)=>`| ${r.category} | ${r.subcategory} | ${r.providerSource.replaceAll("|","/")} | ${r.universeCount??"UNKNOWN"} | ${coverage(r.historicalCompletedCount,r.historicalExpectedCount)} | ${r.historicalRowCount??"UNKNOWN"} | ${r.earliestDatabaseDate??"UNKNOWN"} | ${r.latestProviderDate??"UNKNOWN"} | ${r.latestDatabaseDate??"UNKNOWN"} | ${coverage(r.incrementalCompleted,r.incrementalExpectedCount)} | ${r.currentRunStatus} | ${r.retryQueueCount??"UNKNOWN"} | ${r.schedulerEnabled?"YES":"NO"} | ${r.productionStatus} | ${r.mainBlockingIssue.replaceAll("|","/")} |`);
  const markdown=["# SmartFund Global Data Backfill & Incremental Status Audit","",`- Run ID: \`${runId}\``,`- Generated: ${generatedAt.toISOString()}`,"- Mode: **READ ONLY**. No database row, worker, checkpoint, lock, run ledger, or failure queue was changed.",`- PostgreSQL \`n_live_tup\` activity-estimate delta while audit queries ran: \`${safeJson(tableDeltas)}\`. This non-blocking estimate shows whether tables advanced; it is not used as an exact coverage count.`,"","## Global summary","","| Category | Universe | Historical Coverage | Historical Rows | Earliest | Latest DB Date | Incremental Coverage | Running | Main Gap |","|---|---:|---|---:|---|---|---|---|---|",...summaryLines,"","## Global stock markets","","| Market | Universe | Active | Historical | Rows | Provider Latest | DB Latest | Latest Run | Status | Checkpoint | Retry Queue |","|---|---:|---:|---|---:|---|---|---|---|---|---:|",...stockLines,"","## All asset and data subcategories","","| Category | Subcategory | Provider | Universe | Historical | Rows | Earliest | Provider Latest | DB Latest | Incremental | Status | Retry | Scheduler | Production | Main Gap |","|---|---|---|---:|---|---:|---|---|---|---|---|---:|---|---|---|",...detailLines,"","## Workers at audit completion","","### Railway",...(activeWorkers.length?activeWorkers.map((w)=>`- ${w.jobId}: ${w.status}; ${w.attempted}/${w.universe}; checkpoint=${JSON.stringify(w.checkpoint)}; heartbeat=${w.lastHeartbeat}; ETA=${w.etaMinutes??"UNKNOWN"}m`):["- No active Railway run ledger row at snapshot time."]),"","### Local",...(localWorkers.length?localWorkers.map((w)=>`- PID ${String(w.ProcessId??w.processId)} ${String(w.Name??w.name)}: ${String(w.CommandLine??w.commandLine)}`):["- No local data worker detected."]),"","## Evidence limits","","- `Latest Provider Date` is populated only from an actual production run/provider field; database dates are never substituted for provider dates.","- Fund domicile/share-class detail cannot be truthfully split with the current master fields and is reported as UNKNOWN/PARTIAL.","- `etf_history`, `fund_history`, `market_history`, and `asset_performances` do not retain equivalent row-level provider provenance.","- Stock corporate actions have no canonical event table; adjusted close is not treated as corporate-action history.","- Economic observations use a unique series/date key, so revised values exist but full vintage history is not retained.",`- Query errors: ${errors.length?errors.join("; "):"none"}.`,"",`Machine-readable evidence: \`debug/global-data-audit/${runId}/global-data-status.json\` and \`global-data-status.csv\`.`,""].join("\n");
  await writeFile(join(root,"docs","global-all-data-backfill-status.md"),markdown,"utf8");
  const gapLines=gaps.map((g)=>`| ${g.gapType} | ${g.category} | ${g.market} | ${g.instrument} | ${g.missingComponent} | ${g.currentCoverage} | ${g.blockingReason.replaceAll("|","/")} | ${g.existingDataSource.replaceAll("|","/")} | ${g.currentWorkerStatus} | ${g.nextExecutableAction.replaceAll("|","/")} |`);
  await writeFile(join(root,"docs","global-data-gap-register.md"),["# SmartFund Global Data Gap Register","",`- Audit run: \`${runId}\``,"- No priority is assigned; this is an evidence-based gap inventory only.","","| Gap Type | Category | Market | Instrument | Missing Component | Current Coverage | Blocking Reason | Existing Source | Worker | Next Executable Action |","|---|---|---|---|---|---|---|---|---|---|",...gapLines,"","## Gap type legend","","- A Universe not established; B Historical not backfilled; C Latest incremental absent; D Scheduler absent; E Failure queue absent; F Provider not connected; G Schema only/no data; H Validation incomplete; I Stale; J Source unavailable; K Mapping missing; L Revision/vintage not retained.",""].join("\n"),"utf8");
  console.log(safeJson({runId,rows:rows.length,gaps:gaps.length,categorySummary,currentWorkers:report.currentWorkers,tableDeltas,queryErrors:errors,outputs:{markdown:"docs/global-all-data-backfill-status.md",gap:"docs/global-data-gap-register.md",json:`debug/global-data-audit/${runId}/global-data-status.json`,csv:`debug/global-data-audit/${runId}/global-data-status.csv`}}));
}

main().catch((error:unknown)=>{console.error(error);process.exitCode=1;}).finally(async()=>prisma.$disconnect());
