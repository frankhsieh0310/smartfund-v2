import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { YahooHtmlHistoryProvider, type YahooHistoryRow } from "../../../lib/data-platform/providers/yahoo/YahooHtmlHistoryProvider.ts";
import { fetchYahooChartPeriod, type YahooChartResult } from "../../../lib/services/dataProviders/yahoo/yahooClient.ts";

const prisma = new PrismaClient();
const provider = new YahooHtmlHistoryProvider();
const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const flag = (name: string) => args.includes(`--${name}`);
const market = option("market");
if (!market) throw new Error("MARKET_REQUIRED: use the market-specific production Yahoo daily job");
const limit = Number(option("limit", "0"));
const batchSize = Math.max(1, Number(option("batch-size", "100")));
const dryRun = flag("dry-run");
const testUniversePath = option("test-universe");
const root = process.cwd();
const outputDirectory = resolve(root, option("output-dir", join("debug", "data-008-daily", market.toLowerCase()))!);
const checkpointPath = join(outputDirectory, "checkpoint.json");
const ledgerPath = join(outputDirectory, "daily-ledger.json");
const heartbeatPath = join(outputDirectory, "heartbeat.json");
const rawDirectory = join(outputDirectory, "raw");
const payloadPath = join(outputDirectory, "upsert-payload.jsonl");
const failurePath = join(outputDirectory, "failure-ledger.jsonl");
const reportPath = join(outputDirectory, "validation-report.json");
const toUnix = (date: Date) => Math.floor(date.getTime() / 1_000);
const delay = (milliseconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

type Checkpoint = { lastSymbol?: string; completedSymbols: string[]; updatedAt: string };
type StockInput = { id?: string; ticker?: string; yahooSymbol: string; exchange: string; country: string; latestDate: Date };
type FetchMethod = "YAHOO_CHART_API" | "YAHOO_HTML" | "YAHOO_CHART_FALLBACK";
type FailureType = "YAHOO_TIMEOUT" | "YAHOO_HTTP_429" | "YAHOO_HTTP_AUTH" | "YAHOO_HTTP_ERROR" | "HTML_PARSE_FAILURE" | "EMPTY_RESPONSE" | "VALIDATION_ERROR" | "DATABASE_ERROR" | "UNKNOWN_ERROR";

type TestResult = {
  symbol: string;
  exchange: string;
  country: string;
  yahooSuffix: string | null;
  requestMethod: FetchMethod;
  httpStatus: number | null;
  responseType: string | null;
  currency: string | null;
  timezone: string | null;
  providerExchange: string | null;
  tradeDate: string | null;
  ohlcv: YahooHistoryRow | null;
  adjustedClose: number | null;
  freshness: "UP_TO_PROVIDER_LATEST" | "STALE_OR_EMPTY";
  validation: "PASS" | "FAIL";
  failureType?: FailureType;
  failureReason?: string;
  latencyMs: number;
  fallbackReason?: string;
};

function suffix(symbol: string): string | null {
  const value = symbol.split(".").at(-1);
  return value && value !== symbol ? `.${value}` : null;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1))] ?? null;
}

function classify(error: unknown): FailureType {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|AbortError/i.test(message)) return "YAHOO_TIMEOUT";
  if (/HTTP_429|\b429\b/.test(message)) return "YAHOO_HTTP_429";
  if (/HTTP_(401|403)|\b(401|403)\b/.test(message)) return "YAHOO_HTTP_AUTH";
  if (/HISTORY_TABLE_NOT_FOUND|HTML_PARSE/i.test(message)) return "HTML_PARSE_FAILURE";
  if (/NO_ROWS|EMPTY_RESPONSE/.test(message)) return "EMPTY_RESPONSE";
  if (/VALIDATION_/.test(message)) return "VALIDATION_ERROR";
  if (/Prisma|database/i.test(message)) return "DATABASE_ERROR";
  if (/HTTP_|YAHOO_HTML_FETCH_FAILED/.test(message)) return "YAHOO_HTTP_ERROR";
  return "UNKNOWN_ERROR";
}

async function withTimeout<T>(label: string, task: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${milliseconds}MS`)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeState(value: object): Promise<void> {
  await Promise.all([
    writeFile(ledgerPath, `${JSON.stringify(value, null, 2)}\n`),
    writeFile(heartbeatPath, `${JSON.stringify({ market, at: new Date().toISOString(), status: (value as { status?: string }).status ?? "IN_PROGRESS" }, null, 2)}\n`),
  ]);
}

async function loadCheckpoint(): Promise<Checkpoint> {
  if (!flag("resume")) return { completedSymbols: [], updatedAt: new Date().toISOString() };
  return readFile(checkpointPath, "utf8").then((value) => JSON.parse(value) as Checkpoint).catch(() => ({ completedSymbols: [], updatedAt: new Date().toISOString() }));
}

async function loadTestUniverse(path: string): Promise<StockInput[]> {
  const parsed = JSON.parse(await readFile(resolve(root, path), "utf8")) as Array<{ yahooSymbol: string; exchange: string; country: string; latestDate?: string }>;
  return parsed.map((item) => ({ ...item, ticker: item.yahooSymbol, latestDate: new Date(`${item.latestDate ?? "2026-07-20"}T00:00:00.000Z`) }));
}

async function loadUniverse(): Promise<StockInput[]> {
  if (testUniversePath) return loadTestUniverse(testUniversePath);
  const marketFilter = { exchange: market };
  return prisma.stock.findMany({
    where: { isActive: true, yahooSymbol: { not: "" }, latestDate: { not: null }, ...marketFilter },
    orderBy: { yahooSymbol: "asc" },
    select: { id: true, ticker: true, yahooSymbol: true, exchange: true, country: true, latestDate: true },
    ...(limit > 0 ? { take: limit } : {}),
  }) as Promise<StockInput[]>;
}

function validateRows(rows: YahooHistoryRow[], latestImported: Date): YahooHistoryRow {
  const latest = rows.at(-1);
  if (!latest) throw new Error("EMPTY_RESPONSE");
  if (latest.date < latestImported) throw new Error("VALIDATION_STALE_PROVIDER_RESPONSE");
  if (![latest.open, latest.high, latest.low, latest.close, latest.volume, latest.adjustedClose].every((value) => value !== null && Number.isFinite(value))) throw new Error("VALIDATION_OHLCV_OR_ADJCLOSE_MISSING");
  if (latest.close <= 0 || latest.high < latest.low || latest.open! < 0 || latest.volume! < 0) throw new Error("VALIDATION_INVALID_OHLCV");
  return latest;
}

async function fetchRows(stock: StockInput): Promise<{ rows: YahooHistoryRow[]; method: FetchMethod; html?: string; httpStatus: number | null; responseType: string | null; metadata: YahooChartResult | null; fallbackReason?: string }> {
  const period1 = toUnix(stock.latestDate);
  const period2 = Math.floor((Date.now() + 86_400_000) / 1_000);
  const directMarket = stock.exchange === "TWSE" || stock.exchange === "TPEx";
  if (directMarket) {
    const chart = await withTimeout("YAHOO_CHART", fetchYahooChartPeriod(stock.yahooSymbol, period1, period2), 30_000);
    if (!chart) throw new Error("EMPTY_RESPONSE");
    return { rows: chart.candles.filter((row) => row.close !== null && row.date >= stock.latestDate).map((row) => ({ ...row, close: row.close!, adjustedClose: row.adjClose })), method: "YAHOO_CHART_API", httpStatus: chart.httpStatus, responseType: chart.contentType, metadata: chart };
  }

  try {
    const response = await withTimeout("YAHOO_HTML", provider.fetchHistory(stock.yahooSymbol, period1, period2), 60_000);
    const parsed = provider.parseHistoryHtml(response.html);
    const rows = provider.normalizeRows(parsed.rows).filter((row) => row.date >= stock.latestDate);
    const metadata = await withTimeout("YAHOO_CHART_METADATA", fetchYahooChartPeriod(stock.yahooSymbol, period1, period2), 30_000);
    return { rows, method: "YAHOO_HTML", html: response.html, httpStatus: response.status, responseType: response.contentType, metadata };
  } catch (htmlError) {
    const fallbackReason = htmlError instanceof Error ? htmlError.message : String(htmlError);
    const chart = await withTimeout("YAHOO_CHART_FALLBACK", fetchYahooChartPeriod(stock.yahooSymbol, period1, period2), 30_000);
    if (!chart) throw new Error(`YAHOO_HTML_FAILED_AND_CHART_EMPTY:${fallbackReason}`);
    return { rows: chart.candles.filter((row) => row.close !== null && row.date >= stock.latestDate).map((row) => ({ ...row, close: row.close!, adjustedClose: row.adjClose })), method: "YAHOO_CHART_FALLBACK", httpStatus: chart.httpStatus, responseType: chart.contentType, metadata: chart, fallbackReason };
  }
}

async function persistLiveRows(stock: StockInput, rows: YahooHistoryRow[]): Promise<{ inserted: number; updated: number }> {
  if (!stock.id) throw new Error("DATABASE_STOCK_ID_MISSING");
  const existing = new Set((await prisma.stockHistory.findMany({ where: { stockId: stock.id, date: { gte: stock.latestDate } }, select: { date: true } })).map((value) => value.date.toISOString().slice(0, 10)));
  let inserted = 0;
  let updated = 0;
  for (let index = 0; index < rows.length; index += batchSize) {
    for (const row of rows.slice(index, index + batchSize)) {
      const dateKey = row.date.toISOString().slice(0, 10);
      await prisma.stockHistory.upsert({
        where: { stockId_date: { stockId: stock.id, date: row.date } },
        create: { stockId: stock.id, date: row.date, open: row.open, high: row.high, low: row.low, close: row.close, adjustedClose: row.adjustedClose, volume: row.volume, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_HTML_DAILY", importedAt: new Date(), updatedAt: new Date() },
        update: { open: row.open, high: row.high, low: row.low, close: row.close, adjustedClose: row.adjustedClose, volume: row.volume, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_HTML_DAILY", updatedAt: new Date() },
      });
      if (existing.has(dateKey)) updated += 1; else inserted += 1;
    }
  }
  const newest = rows.at(-1);
  if (newest) await prisma.stock.update({ where: { id: stock.id }, data: { latestDate: newest.date, latestClose: newest.close } });
  return { inserted, updated };
}

async function recordLiveFailure(stock: StockInput, message: string): Promise<void> {
  if (!stock.id) return;
  await prisma.productionSchedulerFailure.upsert({
    where: { jobId_stockId: { jobId: `stock-${market.toLowerCase()}`, stockId: stock.id } },
    create: { jobId: `stock-${market.toLowerCase()}`, stockId: stock.id, symbol: stock.yahooSymbol, lastError: message },
    update: { symbol: stock.yahooSymbol, lastError: message, attempts: { increment: 1 }, lastAttemptedAt: new Date() },
  });
}

async function main(): Promise<void> {
  await Promise.all([mkdir(outputDirectory, { recursive: true }), mkdir(rawDirectory, { recursive: true })]);

  const [checkpoint, allStocks] = await Promise.all([loadCheckpoint(), loadUniverse()]);
  const selected = limit > 0 ? allStocks.slice(0, limit) : allStocks;
  const todo = selected.filter((stock) => !checkpoint.completedSymbols.includes(stock.yahooSymbol));
  const summary = { jobId: `stock-${market.toLowerCase()}`, provider: "YAHOO_HTML_WITH_CHART_FALLBACK", market, mode: dryRun ? "DRY_RUN" : "LIVE", status: "IN_PROGRESS", startedAt: new Date().toISOString(), universe: selected.length, attempted: 0, completed: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, fallbackUsed: 0, emptyResponse: 0, http429: 0, httpAuth: 0, htmlParseFailure: 0, staleData: 0, checkpointPath, payloadPath, failurePath, healthScore: 100 };
  const results: TestResult[] = [];
  const latencies: number[] = [];
  if (!flag("resume")) await Promise.all([writeFile(payloadPath, ""), writeFile(failurePath, "")]);
  await writeState(summary);

  for (const stock of todo) {
    const started = Date.now();
    summary.attempted += 1;
    try {
      const fetched = await fetchRows(stock);
      const latest = validateRows(fetched.rows, stock.latestDate);
      const latencyMs = Date.now() - started;
      latencies.push(latencyMs);
      const result: TestResult = { symbol: stock.yahooSymbol, exchange: stock.exchange, country: stock.country, yahooSuffix: suffix(stock.yahooSymbol), requestMethod: fetched.method, httpStatus: fetched.httpStatus, responseType: fetched.responseType, currency: fetched.metadata?.currency ?? null, timezone: fetched.metadata?.timezone ?? null, providerExchange: fetched.metadata?.exchangeName ?? null, tradeDate: latest.date.toISOString().slice(0, 10), ohlcv: latest, adjustedClose: latest.adjustedClose, freshness: "UP_TO_PROVIDER_LATEST", validation: "PASS", latencyMs, fallbackReason: fetched.fallbackReason };
      if (!result.currency || !result.timezone) throw new Error("VALIDATION_MARKET_METADATA_MISSING");
      if (fetched.html) await writeFile(join(rawDirectory, `${stock.yahooSymbol.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}.html`), fetched.html);
      if (dryRun) await appendFile(payloadPath, `${JSON.stringify({ ...result, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: fetched.method, idempotentKey: `${stock.yahooSymbol}:${result.tradeDate}` })}\n`);
      else {
        const written = await persistLiveRows(stock, fetched.rows);
        summary.inserted += written.inserted;
        summary.updated += written.updated;
      }
      summary.completed += 1;
      if (fetched.method === "YAHOO_CHART_FALLBACK") summary.fallbackUsed += 1;
      checkpoint.completedSymbols.push(stock.yahooSymbol);
      checkpoint.lastSymbol = stock.yahooSymbol;
      checkpoint.updatedAt = new Date().toISOString();
      await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
      results.push(result);
    } catch (error) {
      const latencyMs = Date.now() - started;
      latencies.push(latencyMs);
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const failureType = classify(error);
      if (failureType === "EMPTY_RESPONSE") summary.emptyResponse += 1;
      if (failureType === "YAHOO_HTTP_429") summary.http429 += 1;
      if (failureType === "YAHOO_HTTP_AUTH") summary.httpAuth += 1;
      if (failureType === "HTML_PARSE_FAILURE") summary.htmlParseFailure += 1;
      if (failureType === "VALIDATION_ERROR") summary.staleData += 1;
      const result: TestResult = { symbol: stock.yahooSymbol, exchange: stock.exchange, country: stock.country, yahooSuffix: suffix(stock.yahooSymbol), requestMethod: stock.exchange === "TWSE" || stock.exchange === "TPEx" ? "YAHOO_CHART_API" : "YAHOO_HTML", httpStatus: null, responseType: null, currency: null, timezone: null, providerExchange: null, tradeDate: null, ohlcv: null, adjustedClose: null, freshness: "STALE_OR_EMPTY", validation: "FAIL", failureType, failureReason: message, latencyMs };
      results.push(result);
      await appendFile(failurePath, `${JSON.stringify(result)}\n`);
      if (!dryRun) await recordLiveFailure(stock, message);
    }
    summary.healthScore = Math.max(0, Math.round((summary.completed / Math.max(1, summary.attempted)) * 100));
    await writeState({ ...summary, currentSymbol: stock.yahooSymbol, lastHeartbeatAt: new Date().toISOString() });
    await delay(500 + Math.floor(Math.random() * 300));
  }

  const byExchange = Object.values(results.reduce<Record<string, { exchange: string; country: string; attempted: number; completed: number; failed: number }>>((accumulator, result) => {
    const bucket = accumulator[result.exchange] ?? { exchange: result.exchange, country: result.country, attempted: 0, completed: 0, failed: 0 };
    bucket.attempted += 1; if (result.validation === "PASS") bucket.completed += 1; else bucket.failed += 1; accumulator[result.exchange] = bucket; return accumulator;
  }, {})).map((item) => ({ ...item, successRate: item.attempted ? Number(((item.completed / item.attempted) * 100).toFixed(2)) : 0, readiness: item.attempted > 0 && item.completed / item.attempted >= 0.98 ? "READY_FOR_STAGE_1" : "NOT_READY" }));
  const completedAt = new Date().toISOString();
  const report = { ...summary, status: summary.failed === 0 ? "COMPLETED" : "COMPLETED_WITH_FAILURES", completedAt, currentSymbol: null, successRate: Number(((summary.completed / Math.max(1, summary.attempted)) * 100).toFixed(2)), averageLatencyMs: latencies.length ? Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length) : null, p95LatencyMs: percentile(latencies, 0.95), byExchange, results, checkpoint, artifacts: { payloadPath, failurePath, reportPath, rawDirectory } };
  await Promise.all([writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`), writeState(report)]);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => { await provider.close(); await prisma.$disconnect(); });
