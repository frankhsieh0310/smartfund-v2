import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { PrismaClient } from "@prisma/client";
import {
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  heartbeatLifecycleLock,
  loadLifecycleResumeCheckpoint,
  persistLifecycleCheckpoint,
  recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
  type RunSummary,
} from "../production/run-lifecycle.ts";

type Market = "TWSE" | "TPEX";
type StatementType = "income" | "balance" | "cashflow";

type SourceTask = {
  market: Market;
  rocYear: number;
  season: number;
  statementType: StatementType;
  endpoint: string;
  sourceKey: string;
  periodEnd: string;
};

type ParsedFact = {
  officialSymbol: string;
  issuerName: string;
  statementType: StatementType;
  metric: string;
  sourceField: string;
  value: string;
  unit: string;
  currency: "TWD";
  fiscalYear: number;
  fiscalPeriod: string;
  periodStart: string;
  periodEnd: string;
  source: string;
  sourceFactKey: string;
  sourceUrl: string;
  sourceMarket: Market;
  downloadedAt: string;
  rawArchiveReference: string;
  rawSha256: string;
};

type FileCheckpoint = {
  version: 1;
  market: Market;
  fromRocYear: number;
  toRocYear: number;
  lastSourceKey: string | null;
  processedDocuments: number;
  parsedFacts: number;
  failedDocuments: number;
  updatedAt: string;
};

type RunReport = {
  market: Market;
  mode: "ARCHIVE_ONLY" | "APPLY" | "INCREMENTAL";
  startedAt: string;
  finishedAt: string;
  sourceDocuments: number;
  failedDocuments: number;
  rawArchiveCount: number;
  normalizedFactCount: number;
  databaseFactCount: number;
  universe: number;
  officialSymbols: number;
  mappedIssuers: number;
  missingIdentifiers: number;
  missingIdentifierSymbols: string[];
  financialComplete: number;
  financialPartial: number;
  noFiling: number;
  unsupportedSecurity: number;
  statusLedger: string | null;
  earliestPeriod: string | null;
  latestPeriod: string | null;
  checkpoint: string | null;
  failures: Array<{ sourceKey: string; reason: string }>;
};

type CoverageRow = {
  stock_id: string;
  ticker: string;
  company_name: string;
  fact_count: bigint | number;
  statement_types: bigint | number;
  earliest_period: Date | null;
  latest_period: Date | null;
};

type MarketCoverage = {
  universe: number;
  mappedIssuers: number;
  missingIdentifierSymbols: string[];
  financialComplete: number;
  financialPartial: number;
  noFiling: number;
  unsupportedSecurity: number;
  databaseFactCount: number;
  earliestPeriod: string | null;
  latestPeriod: string | null;
  ledgerPath: string;
};

const MOPS_BASE = "https://mopsov.twse.com.tw/mops/web";
const ENDPOINTS: Record<StatementType, string> = {
  income: `${MOPS_BASE}/ajax_t163sb04`,
  balance: `${MOPS_BASE}/ajax_t163sb05`,
  cashflow: `${MOPS_BASE}/ajax_t163sb20`,
};
const SOURCE_BY_MARKET: Record<Market, string> = {
  TWSE: "MOPS_TWSE_FINANCIAL",
  TPEX: "MOPS_TPEX_FINANCIAL",
};
const TYPEK_BY_MARKET: Record<Market, string> = { TWSE: "sii", TPEX: "otc" };
const OUTPUT_ROOT = path.resolve("runtime", "official-financial", "taiwan");
const DEFAULT_FROM_ROC_YEAR = 102;
const REQUEST_TIMEOUT_MS = 45_000;
const REQUEST_DELAY_MS = 650;

const args = new Set(process.argv.slice(2));
const valueArg = (name: string) => process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const apply = args.has("--apply");
const resume = args.has("--resume");
const incremental = args.has("--incremental");
const currentRocYear = new Date().getUTCFullYear() - 1911;
const fromRocYear = Number(valueArg("--from-year") ?? (incremental ? currentRocYear - 1 : DEFAULT_FROM_ROC_YEAR));
const toRocYear = Number(valueArg("--to-year") ?? currentRocYear);
const targetDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const requestedMarkets = (valueArg("--markets") ?? "TWSE,TPEX")
  .split(",")
  .map((market) => market.trim().toUpperCase())
  .filter((market): market is Market => market === "TWSE" || market === "TPEX");

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function periodEnd(rocYear: number, season: number): string {
  const year = rocYear + 1911;
  const dates = ["03-31", "06-30", "09-30", "12-31"];
  return `${year}-${dates[season - 1]}`;
}

function periodStart(rocYear: number): string {
  return `${rocYear + 1911}-01-01`;
}

function fiscalPeriod(season: number): string {
  return season === 4 ? "FY" : `Q${season}_YTD`;
}

function createTasks(market: Market): SourceTask[] {
  const tasks: SourceTask[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let rocYear = fromRocYear; rocYear <= toRocYear; rocYear += 1) {
    for (let season = 1; season <= 4; season += 1) {
      const end = periodEnd(rocYear, season);
      if (end > today) continue;
      for (const statementType of Object.keys(ENDPOINTS) as StatementType[]) {
        tasks.push({
          market,
          rocYear,
          season,
          statementType,
          endpoint: ENDPOINTS[statementType],
          sourceKey: `${market}:${rocYear}:Q${season}:${statementType}`,
          periodEnd: end,
        });
      }
    }
  }
  return tasks;
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parseNumber(value: string): string | null {
  const normalized = normalizeText(value)
    .replace(/,/g, "")
    .replace(/％/g, "")
    .replace(/%/g, "")
    .replace(/^\((.+)\)$/, "-$1");
  if (!normalized || normalized === "--" || normalized === "-" || normalized === "N/A") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? normalized : null;
}

function canonicalMetric(statementType: StatementType, sourceField: string): { metric: string; unit: string } {
  const field = sourceField.replace(/\s+/g, "");
  const mappings: Array<[RegExp, string, string]> = statementType === "income"
    ? [
        [/^(營業收入|收入|收益合計)$/, "financial.revenue", "TWD_THOUSANDS"],
        [/^(營業成本|支出合計)$/, "financial.cost_of_revenue", "TWD_THOUSANDS"],
        [/營業毛利|營業毛損/, "financial.gross_profit", "TWD_THOUSANDS"],
        [/^營業費用/, "financial.operating_expenses", "TWD_THOUSANDS"],
        [/營業利益|營業損失/, "financial.operating_income", "TWD_THOUSANDS"],
        [/稅前.*(淨利|淨損|利益|損失)/, "financial.pretax_income", "TWD_THOUSANDS"],
        [/所得稅(費用|利益)/, "financial.income_tax", "TWD_THOUSANDS"],
        [/^(本期淨利|本期淨損|本期稅後淨利|本期稅後淨損)/, "financial.net_income", "TWD_THOUSANDS"],
        [/基本每股盈餘|基本每股虧損/, "financial.basic_eps", "TWD_PER_SHARE"],
        [/稀釋每股盈餘|稀釋每股虧損/, "financial.diluted_eps", "TWD_PER_SHARE"],
      ]
    : statementType === "balance"
      ? [
          [/^現金及約當現金$/, "financial.cash_and_cash_equivalents", "TWD_THOUSANDS"],
          [/短期投資|透過損益按公允價值衡量之金融資產.*流動|按攤銷後成本衡量之金融資產.*流動/, "financial.short_term_investments", "TWD_THOUSANDS"],
          [/應收帳款/, "financial.accounts_receivable", "TWD_THOUSANDS"],
          [/^存貨/, "financial.inventory", "TWD_THOUSANDS"],
          [/^流動資產/, "financial.current_assets", "TWD_THOUSANDS"],
          [/不動產、廠房及設備|不動產廠房及設備/, "financial.property_plant_equipment", "TWD_THOUSANDS"],
          [/^資產總計$/, "financial.total_assets", "TWD_THOUSANDS"],
          [/^流動負債/, "financial.current_liabilities", "TWD_THOUSANDS"],
          [/短期借款|短期債務/, "financial.short_term_debt", "TWD_THOUSANDS"],
          [/長期借款|長期債務/, "financial.long_term_debt", "TWD_THOUSANDS"],
          [/^負債總計$/, "financial.total_liabilities", "TWD_THOUSANDS"],
          [/權益總計|權益總額/, "financial.shareholders_equity", "TWD_THOUSANDS"],
        ]
      : [
          [/營業活動之淨現金流入|營業活動之淨現金流出/, "financial.operating_cash_flow", "TWD_THOUSANDS"],
          [/投資活動之淨現金流入|投資活動之淨現金流出/, "financial.investing_cash_flow", "TWD_THOUSANDS"],
          [/籌資活動之淨現金流入|籌資活動之淨現金流出/, "financial.financing_cash_flow", "TWD_THOUSANDS"],
          [/取得不動產、廠房及設備|購置不動產、廠房及設備/, "financial.capital_expenditure", "TWD_THOUSANDS"],
          [/期末現金及約當現金餘額/, "financial.ending_cash_and_cash_equivalents", "TWD_THOUSANDS"],
        ];
  const found = mappings.find(([pattern]) => pattern.test(field));
  if (found) return { metric: found[1], unit: found[2] };
  return { metric: `mops.raw.${statementType}.${field}`, unit: /每股/.test(field) ? "TWD_PER_SHARE" : "TWD_THOUSANDS" };
}

function parseMopsHtml(task: SourceTask, html: string, archiveReference: string, rawSha256: string, downloadedAt: string): ParsedFact[] {
  const $ = load(html);
  const facts: ParsedFact[] = [];
  $("table.hasBorder").each((_, table) => {
    let headers: string[] = [];
    $(table).find("tr").each((__, row) => {
      const cells = $(row).find("th,td").toArray().map((cell) => normalizeText($(cell).text()));
      if (cells.length < 3) return;
      const containsHeader = $(row).find("th").length > 0 || /公司.*代號/.test(cells[0]);
      if (containsHeader) {
        headers = cells;
        return;
      }
      if (headers.length !== cells.length) return;
      const officialSymbol = cells[0].replace(/\s+/g, "");
      if (!/^[0-9A-Z]{4,8}$/.test(officialSymbol)) return;
      const issuerName = cells[1];
      for (let index = 2; index < cells.length; index += 1) {
        const sourceField = headers[index];
        const value = parseNumber(cells[index]);
        if (!sourceField || value === null) continue;
        const mapped = canonicalMetric(task.statementType, sourceField);
        facts.push({
          officialSymbol,
          issuerName,
          statementType: task.statementType,
          metric: mapped.metric,
          sourceField,
          value,
          unit: mapped.unit,
          currency: "TWD",
          fiscalYear: task.rocYear + 1911,
          fiscalPeriod: fiscalPeriod(task.season),
          periodStart: periodStart(task.rocYear),
          periodEnd: task.periodEnd,
          source: SOURCE_BY_MARKET[task.market],
          sourceFactKey: `${task.sourceKey}:${officialSymbol}:${sourceField}`,
          sourceUrl: task.endpoint,
          sourceMarket: task.market,
          downloadedAt,
          rawArchiveReference: archiveReference,
          rawSha256,
        });
      }
    });
  });
  return facts;
}

async function fetchMops(task: SourceTask): Promise<{ html: string; downloadedAt: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const body = new URLSearchParams({
        encodeURIComponent: "1",
        step: "1",
        firstin: "1",
        off: "1",
        TYPEK: TYPEK_BY_MARKET[task.market],
        year: String(task.rocYear),
        season: String(task.season),
      });
      const response = await fetch(task.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "SmartFund Official Filing Ingestion/1.0 contact@smartfund.app",
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const html = await response.text();
      if (!html.includes("公司") || !html.includes("hasBorder")) throw new Error("MOPS_EMPTY_OR_UNEXPECTED_RESPONSE");
      return { html, downloadedAt: new Date().toISOString() };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1_000 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

function checkpointPath(market: Market): string {
  const mode = incremental ? `incremental-${targetDate.toISOString().slice(0, 10)}` : apply ? "apply" : "archive";
  return path.join(OUTPUT_ROOT, market.toLowerCase(), `checkpoint-${mode}.json`);
}

async function readCheckpoint(market: Market): Promise<FileCheckpoint | null> {
  try {
    return JSON.parse(await readFile(checkpointPath(market), "utf8")) as FileCheckpoint;
  } catch {
    return null;
  }
}

async function persistFileCheckpoint(checkpoint: FileCheckpoint): Promise<void> {
  const content = `${JSON.stringify(checkpoint, null, 2)}\n`;
  await writeAtomic(checkpointPath(checkpoint.market), content);
  await writeAtomic(path.join(OUTPUT_ROOT, checkpoint.market.toLowerCase(), incremental ? "checkpoint-incremental.json" : "checkpoint.json"), content);
}

async function archiveTask(task: SourceTask, html: string, facts: ParsedFact[]): Promise<{ htmlPath: string; factsPath: string }> {
  const directory = path.join(OUTPUT_ROOT, task.market.toLowerCase(), "raw", String(task.rocYear), `Q${task.season}`);
  const htmlPath = path.join(directory, `${task.statementType}.html`);
  const factsPath = path.join(directory, `${task.statementType}.jsonl`);
  await writeAtomic(htmlPath, html);
  await writeAtomic(factsPath, facts.map((fact) => JSON.stringify(fact)).join("\n") + (facts.length ? "\n" : ""));
  return { htmlPath, factsPath };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function summarizeArchives(tasks: SourceTask[]): Promise<{
  factCount: number;
  rawArchiveCount: number;
  officialSymbols: Set<string>;
  earliestPeriod: string | null;
  latestPeriod: string | null;
}> {
  let factCount = 0;
  let rawArchiveCount = 0;
  let earliestPeriod: string | null = null;
  let latestPeriod: string | null = null;
  const officialSymbols = new Set<string>();
  for (const task of tasks) {
    const directory = path.join(OUTPUT_ROOT, task.market.toLowerCase(), "raw", String(task.rocYear), `Q${task.season}`);
    const htmlPath = path.join(directory, `${task.statementType}.html`);
    const factsPath = path.join(directory, `${task.statementType}.jsonl`);
    if (!await fileExists(htmlPath) || !await fileExists(factsPath)) continue;
    rawArchiveCount += 1;
    const content = await readFile(factsPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      const fact = JSON.parse(line) as Pick<ParsedFact, "officialSymbol" | "periodEnd">;
      factCount += 1;
      officialSymbols.add(fact.officialSymbol);
      earliestPeriod = !earliestPeriod || fact.periodEnd < earliestPeriod ? fact.periodEnd : earliestPeriod;
      latestPeriod = !latestPeriod || fact.periodEnd > latestPeriod ? fact.periodEnd : latestPeriod;
    }
  }
  return { factCount, rawArchiveCount, officialSymbols, earliestPeriod, latestPeriod };
}

async function upsertFacts(prisma: PrismaClient, market: Market, facts: ParsedFact[]): Promise<{ mapped: number; missing: string[]; rows: number }> {
  const symbols = [...new Set(facts.map((fact) => fact.officialSymbol))];
  const stocks = await prisma.stock.findMany({
    where: { exchange: market === "TPEX" ? { in: ["TPEX", "TPEx"] } : "TWSE", ticker: { in: symbols } },
    select: { id: true, ticker: true },
  });
  const stockByTicker = new Map(stocks.map((stock) => [stock.ticker, stock.id]));
  const missing = symbols.filter((symbol) => !stockByTicker.has(symbol));
  let rows = 0;
  for (let offset = 0; offset < facts.length; offset += 5_000) {
    const payload = facts.slice(offset, offset + 5_000).flatMap((fact) => {
      const stockId = stockByTicker.get(fact.officialSymbol);
      if (!stockId) return [];
      return [{
        id: randomUUID(),
        stock_id: stockId,
        metric: fact.metric,
        period_start: fact.periodStart,
        period_end: fact.periodEnd,
        fiscal_period: fact.fiscalPeriod,
        form_type: `MOPS_${fact.statementType.toUpperCase()}`,
        value: fact.value,
        unit: fact.unit,
        currency: fact.currency,
        source: fact.source,
        source_fact_key: fact.sourceFactKey,
        source_document_url: fact.sourceUrl,
        restatement_version: fact.rawSha256,
      }];
    });
    if (!payload.length) continue;
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_financial_facts
        (id, stock_id, metric, period_start, period_end, fiscal_period, form_type, value, unit, currency, source, source_fact_key, source_document_url, restatement_version, imported_at, updated_at)
       SELECT x.id::uuid, x.stock_id::uuid, x.metric, x.period_start::date, x.period_end::date, x.fiscal_period, x.form_type,
              x.value::numeric, x.unit, x.currency, x.source, x.source_fact_key, x.source_document_url, x.restatement_version, NOW(), NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, stock_id text, metric text, period_start text, period_end text, fiscal_period text, form_type text,
         value text, unit text, currency text, source text, source_fact_key text, source_document_url text, restatement_version text
       )
       ON CONFLICT (stock_id, metric, period_end, source, source_fact_key)
       DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit, currency = EXCLUDED.currency,
         period_start = EXCLUDED.period_start, fiscal_period = EXCLUDED.fiscal_period, form_type = EXCLUDED.form_type,
         source_document_url = EXCLUDED.source_document_url, restatement_version = EXCLUDED.restatement_version, updated_at = NOW()`,
      JSON.stringify(payload),
    );
    rows += payload.length;
  }
  return { mapped: stocks.length, missing, rows };
}

async function buildMarketCoverage(prisma: PrismaClient, market: Market, officialSymbols: Set<string>): Promise<MarketCoverage> {
  const exchangeSql = market === "TWSE" ? "s.exchange = 'TWSE'" : "s.exchange IN ('TPEX', 'TPEx')";
  const rows = await prisma.$queryRawUnsafe<CoverageRow[]>(
    `SELECT s.id AS stock_id, s.ticker, s.company_name,
            COUNT(f.id)::bigint AS fact_count,
            COUNT(DISTINCT f.form_type)::bigint AS statement_types,
            MIN(f.period_end) AS earliest_period,
            MAX(f.period_end) AS latest_period
       FROM stocks s
       LEFT JOIN stock_financial_facts f ON f.stock_id = s.id AND f.source = $1
      WHERE ${exchangeSql}
      GROUP BY s.id, s.ticker, s.company_name
      ORDER BY s.ticker`,
    SOURCE_BY_MARKET[market],
  );
  const stockSymbols = new Set(rows.map((row) => row.ticker));
  const missingIdentifierSymbols = [...officialSymbols].filter((symbol) => !stockSymbols.has(symbol)).sort();
  const ledger = rows.map((row) => {
    const factCount = Number(row.fact_count);
    const statementTypes = Number(row.statement_types);
    const status = factCount === 0 ? "NO_FILING" : statementTypes === 3 ? "COMPLETE" : "PARTIAL_SOURCE_DATA";
    return {
      stockId: row.stock_id,
      symbol: row.ticker,
      companyName: row.company_name,
      market,
      status,
      factCount,
      statementTypes,
      earliestPeriod: row.earliest_period?.toISOString().slice(0, 10) ?? null,
      latestPeriod: row.latest_period?.toISOString().slice(0, 10) ?? null,
      source: SOURCE_BY_MARKET[market],
    };
  });
  const ledgerPath = path.join(OUTPUT_ROOT, market.toLowerCase(), "stock-status-ledger.json");
  await writeAtomic(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return {
    universe: rows.length,
    mappedIssuers: rows.filter((row) => Number(row.fact_count) > 0).length,
    missingIdentifierSymbols,
    financialComplete: ledger.filter((row) => row.status === "COMPLETE").length,
    financialPartial: ledger.filter((row) => row.status === "PARTIAL_SOURCE_DATA").length,
    noFiling: ledger.filter((row) => row.status === "NO_FILING").length,
    unsupportedSecurity: 0,
    databaseFactCount: ledger.reduce((total, row) => total + row.factCount, 0),
    earliestPeriod: ledger.reduce<string | null>((earliest, row) => row.earliestPeriod && (!earliest || row.earliestPeriod < earliest) ? row.earliestPeriod : earliest, null),
    latestPeriod: ledger.reduce<string | null>((latest, row) => row.latestPeriod && (!latest || row.latestPeriod > latest) ? row.latestPeriod : latest, null),
    ledgerPath: path.relative(process.cwd(), ledgerPath).replace(/\\/g, "/"),
  };
}

function restoreSummary(checkpoint: FileCheckpoint | null): RunSummary {
  const summary = createSummary();
  if (!checkpoint) return summary;
  summary.attempted = checkpoint.processedDocuments;
  summary.completed = checkpoint.processedDocuments - checkpoint.failedDocuments;
  summary.success = summary.completed;
  summary.failed = checkpoint.failedDocuments;
  summary.retryableFailure = checkpoint.failedDocuments;
  summary.inserted = checkpoint.parsedFacts;
  return summary;
}

async function runMarket(market: Market): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const jobId = `official-financial-${market.toLowerCase()}-${incremental ? "incremental" : "historical"}`;
  const runType = incremental ? "OFFICIAL_FINANCIAL_INCREMENTAL" : "OFFICIAL_FINANCIAL_HISTORICAL";
  const owner = `${process.env.RAILWAY_REPLICA_ID ?? "local"}:${process.pid}`;
  const prisma = apply ? new PrismaClient() : null;
  let runId: string | null = null;
  let lockHeld = false;
  const savedCheckpoint = resume ? await readCheckpoint(market) : null;
  let checkpoint = savedCheckpoint?.fromRocYear === fromRocYear && savedCheckpoint?.toRocYear === toRocYear
    ? savedCheckpoint
    : null;
  let summary = restoreSummary(checkpoint);
  const failures: Array<{ sourceKey: string; reason: string }> = [];
  const officialSymbols = new Set<string>();
  const mappedSymbols = new Set<string>();
  const missingSymbols = new Set<string>();
  let databaseFactCount = 0;
  let rawArchiveCount = checkpoint?.processedDocuments ?? 0;
  let earliestPeriod: string | null = null;
  let latestPeriod: string | null = null;

  try {
    if (prisma) {
      await recoverOrphanedLifecycleRun(prisma, jobId);
      lockHeld = await acquireLifecycleLock(prisma, jobId, owner);
      if (!lockHeld) throw new Error(`SKIPPED_LOCKED:${jobId}`);
      runId = await createLifecycleRun(prisma, jobId, market, runType, incremental ? {
        targetTradeDate: targetDate,
        runKey: `${jobId}:${targetDate.toISOString().slice(0, 10)}`,
      } : {});
      const existingRun = incremental
        ? await prisma.$queryRawUnsafe<Array<{ status: string }>>("SELECT status FROM production_scheduler_runs WHERE id = $1", runId)
        : [];
      if (existingRun[0]?.status === "COMPLETED") {
        console.log(JSON.stringify({ status: "SKIPPED_COMPLETED", market, jobId, targetDate: targetDate.toISOString().slice(0, 10) }));
        return {
          market, mode: "INCREMENTAL", startedAt, finishedAt: new Date().toISOString(), sourceDocuments: 0,
          failedDocuments: 0, rawArchiveCount: 0, normalizedFactCount: 0, databaseFactCount: 0,
          universe: 0, officialSymbols: 0, mappedIssuers: 0, missingIdentifiers: 0,
          missingIdentifierSymbols: [], financialComplete: 0, financialPartial: 0, noFiling: 0,
          unsupportedSecurity: 0, statusLedger: null, earliestPeriod: null, latestPeriod: null,
          checkpoint: null, failures: [],
        };
      }
      const dbCheckpoint = resume ? await loadLifecycleResumeCheckpoint(prisma, jobId, incremental ? { targetTradeDate: targetDate, runType } : undefined) : null;
      if (dbCheckpoint?.last_symbol && !checkpoint?.lastSourceKey) {
        checkpoint = {
          version: 1,
          market,
          fromRocYear,
          toRocYear,
          lastSourceKey: dbCheckpoint.last_symbol,
          processedDocuments: dbCheckpoint.processed,
          parsedFacts: Number(dbCheckpoint.details?.inserted ?? 0),
          failedDocuments: dbCheckpoint.failed,
          updatedAt: new Date().toISOString(),
        };
        summary = restoreSummary(checkpoint);
        if (dbCheckpoint.details) Object.assign(summary, dbCheckpoint.details);
        console.log(JSON.stringify({ status: "RESUMED_FROM_DATABASE_CHECKPOINT", market, jobId, lastSourceKey: dbCheckpoint.last_symbol, processed: dbCheckpoint.processed }));
      }
    }

    const allTasks = createTasks(market);
    const resumeIndex = checkpoint?.lastSourceKey ? allTasks.findIndex((task) => task.sourceKey === checkpoint.lastSourceKey) : -1;
    const tasks = apply
      ? (resumeIndex >= 0 ? allTasks.slice(resumeIndex + 1) : allTasks)
      : allTasks;
    if (checkpoint?.lastSourceKey && resumeIndex < 0) throw new Error(`CHECKPOINT_SOURCE_KEY_NOT_FOUND:${checkpoint.lastSourceKey}`);

    for (const task of tasks) {
      if (!apply && resume) {
        const existingDirectory = path.join(OUTPUT_ROOT, market.toLowerCase(), "raw", String(task.rocYear), `Q${task.season}`);
        if (await fileExists(path.join(existingDirectory, `${task.statementType}.html`)) && await fileExists(path.join(existingDirectory, `${task.statementType}.jsonl`))) {
          continue;
        }
      }
      summary.attempted += 1;
      let facts: ParsedFact[] = [];
      try {
        const marketRoot = path.join(OUTPUT_ROOT, market.toLowerCase());
        const rawRelative = path.join("raw", String(task.rocYear), `Q${task.season}`, `${task.statementType}.html`).replace(/\\/g, "/");
        const htmlPath = path.join(marketRoot, rawRelative);
        let html: string;
        let downloadedAt: string;
        if (resume && await fileExists(htmlPath)) {
          html = await readFile(htmlPath, "utf8");
          downloadedAt = new Date((await stat(htmlPath)).mtimeMs).toISOString();
        } else {
          ({ html, downloadedAt } = await fetchMops(task));
        }
        const rawSha256 = createHash("sha256").update(html).digest("hex");
        facts = parseMopsHtml(task, html, rawRelative, rawSha256, downloadedAt);
        if (!facts.length) throw new Error("PARSE_FAILURE:NO_FINANCIAL_FACTS");
        await archiveTask(task, html, facts);
        rawArchiveCount += 1;
        for (const fact of facts) officialSymbols.add(fact.officialSymbol);
        if (prisma) {
          const result = await upsertFacts(prisma, market, facts);
          databaseFactCount += result.rows;
          facts.forEach((fact) => result.missing.includes(fact.officialSymbol) ? missingSymbols.add(fact.officialSymbol) : mappedSymbols.add(fact.officialSymbol));
        }
        summary.completed += 1;
        summary.success += 1;
        summary.inserted += facts.length;
        earliestPeriod = !earliestPeriod || task.periodEnd < earliestPeriod ? task.periodEnd : earliestPeriod;
        latestPeriod = !latestPeriod || task.periodEnd > latestPeriod ? task.periodEnd : latestPeriod;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        summary.failed += 1;
        summary.retryableFailure += 1;
        failures.push({ sourceKey: task.sourceKey, reason });
      }

      const nextCheckpoint: FileCheckpoint = {
        version: 1,
        market,
        fromRocYear,
        toRocYear,
        lastSourceKey: task.sourceKey,
        processedDocuments: summary.attempted,
        parsedFacts: summary.inserted,
        failedDocuments: summary.failed,
        updatedAt: new Date().toISOString(),
      };
      await persistFileCheckpoint(nextCheckpoint);
      if (prisma && runId) {
        await persistLifecycleCheckpoint(prisma, runId, summary, task.sourceKey, incremental ? { jobId, targetTradeDate: targetDate, runType } : undefined);
        await heartbeatLifecycleLock(prisma, jobId, owner);
      }
      console.log(JSON.stringify({ market, sourceKey: task.sourceKey, facts: facts.length, processed: summary.attempted, failed: summary.failed }));
      await sleep(REQUEST_DELAY_MS);
    }

    const archiveSummary = apply
      ? {
          factCount: summary.inserted,
          rawArchiveCount: summary.completed,
          officialSymbols,
          earliestPeriod,
          latestPeriod,
        }
      : await summarizeArchives(allTasks);
    archiveSummary.officialSymbols.forEach((symbol) => officialSymbols.add(symbol));
    rawArchiveCount = archiveSummary.rawArchiveCount;
    earliestPeriod = archiveSummary.earliestPeriod;
    latestPeriod = archiveSummary.latestPeriod;
    if (!apply) summary.inserted = archiveSummary.factCount;

    if (!apply) {
      summary.attempted = allTasks.length;
      summary.completed = archiveSummary.rawArchiveCount;
      summary.success = archiveSummary.rawArchiveCount;
      summary.failed = allTasks.length - archiveSummary.rawArchiveCount;
      summary.retryableFailure = summary.failed;
      await persistFileCheckpoint({
        version: 1,
        market,
        fromRocYear,
        toRocYear,
        lastSourceKey: allTasks.at(-1)?.sourceKey ?? null,
        processedDocuments: summary.attempted,
        parsedFacts: archiveSummary.factCount,
        failedDocuments: summary.failed,
        updatedAt: new Date().toISOString(),
      });
    }
    const coverage = prisma
      ? await buildMarketCoverage(prisma, market, officialSymbols)
      : null;
    if (coverage) {
      databaseFactCount = coverage.databaseFactCount;
      coverage.missingIdentifierSymbols.forEach((symbol) => missingSymbols.add(symbol));
      earliestPeriod = coverage.earliestPeriod;
      latestPeriod = coverage.latestPeriod;
    }
    const validation = {
      status: failures.length === 0 && archiveSummary.rawArchiveCount === allTasks.length ? "PASS" : "FAIL",
      sourceDocumentsExpected: allTasks.length,
      sourceDocumentsProcessed: archiveSummary.rawArchiveCount,
      sourceDocumentsFailed: summary.failed,
      normalizedFacts: archiveSummary.factCount,
      rawArchiveCount,
      officialSymbols: officialSymbols.size,
      universe: coverage?.universe ?? null,
      mappedIssuers: coverage?.mappedIssuers ?? mappedSymbols.size,
      financialComplete: coverage?.financialComplete ?? null,
      financialPartial: coverage?.financialPartial ?? null,
      noFiling: coverage?.noFiling ?? null,
      missingIdentifiers: coverage?.missingIdentifierSymbols ?? [...missingSymbols].sort(),
    };
    if (prisma && runId) await completeLifecycleRun(prisma, runId, summary, latestPeriod ? new Date(`${latestPeriod}T00:00:00.000Z`) : null, validation);

    const report: RunReport = {
      market,
      mode: incremental ? "INCREMENTAL" : apply ? "APPLY" : "ARCHIVE_ONLY",
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceDocuments: archiveSummary.rawArchiveCount,
      failedDocuments: allTasks.length - archiveSummary.rawArchiveCount,
      rawArchiveCount,
      normalizedFactCount: archiveSummary.factCount,
      databaseFactCount,
      universe: coverage?.universe ?? 0,
      officialSymbols: officialSymbols.size,
      mappedIssuers: coverage?.mappedIssuers ?? mappedSymbols.size,
      missingIdentifiers: coverage?.missingIdentifierSymbols.length ?? missingSymbols.size,
      missingIdentifierSymbols: coverage?.missingIdentifierSymbols ?? [...missingSymbols].sort(),
      financialComplete: coverage?.financialComplete ?? 0,
      financialPartial: coverage?.financialPartial ?? 0,
      noFiling: coverage?.noFiling ?? 0,
      unsupportedSecurity: coverage?.unsupportedSecurity ?? 0,
      statusLedger: coverage?.ledgerPath ?? null,
      earliestPeriod,
      latestPeriod,
      checkpoint: (await readCheckpoint(market))?.lastSourceKey ?? null,
      failures,
    };
    await writeAtomic(path.join(OUTPUT_ROOT, market.toLowerCase(), "run-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeAtomic(path.join(OUTPUT_ROOT, market.toLowerCase(), "failure-ledger.json"), `${JSON.stringify(failures, null, 2)}\n`);
    return report;
  } catch (error) {
    if (prisma && runId) await failLifecycleRun(prisma, runId, error);
    throw error;
  } finally {
    if (prisma && lockHeld) await releaseLifecycleLock(prisma, jobId, owner).catch(() => undefined);
    if (prisma) await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  if (!Number.isInteger(fromRocYear) || !Number.isInteger(toRocYear) || fromRocYear > toRocYear) {
    throw new Error("INVALID_YEAR_RANGE");
  }
  if (!requestedMarkets.length) throw new Error("NO_SUPPORTED_MARKETS_REQUESTED");
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const reports: RunReport[] = [];
  for (const market of requestedMarkets) reports.push(await runMarket(market));
  await writeAtomic(path.join(OUTPUT_ROOT, "latest-run.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`);
  console.log(JSON.stringify({ status: reports.every((report) => report.failedDocuments === 0) ? "COMPLETED" : "COMPLETED_WITH_FAILURES", reports }, null, 2));
  if (reports.some((report) => report.failedDocuments > 0)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
