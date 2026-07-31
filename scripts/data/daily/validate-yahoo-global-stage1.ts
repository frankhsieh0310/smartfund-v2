import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { YahooHtmlHistoryProvider, type YahooHistoryRow } from "../../../lib/data-platform/providers/yahoo/YahooHtmlHistoryProvider.ts";
import { getAuth } from "../../../lib/services/dataProviders/yahoo/yahooClient.ts";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => args.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const flag = (name: string) => args.includes(`--${name}`);
const sampleSize = Number(option("sample-size", "100"));
// The shared Playwright browser is stable at two independent contexts.  Higher
// concurrency caused transport failures during the pre-flight run and is not a
// valid basis for a production-readiness score.
const concurrency = Math.max(1, Math.min(2, Number(option("concurrency", "2"))));
const seed = Number(option("seed", "20260731"));
const outputDirectory = resolve(ROOT, option("output-dir", "debug/data-008-daily/global-stage1")!);
const checkpointPath = join(outputDirectory, "checkpoint.json");
const ledgerPath = join(outputDirectory, "stage1-ledger.json");
const payloadPath = join(outputDirectory, "validated-payload.jsonl");
const failurePath = join(outputDirectory, "failure-ledger.jsonl");
const csvPath = join(outputDirectory, "validation-results.csv");
const reportPath = join(outputDirectory, "validation-report.json");
const manifestPath = join(outputDirectory, "sample-manifest.json");
const htmlDirectory = join(outputDirectory, "raw-html");
const chartDirectory = join(outputDirectory, "raw-chart-json");
const checkpointUniversePath = join(ROOT, "debug", "data-008-daily", "global_ex_tw", "checkpoint.json");
const parserVersion = "YAHOO_HTML_HISTORY_V1";
const provider = new YahooHtmlHistoryProvider();

type Market = { name: string; country: string; suffix?: string; region?: string; exchanges?: string[]; amex?: boolean };
type Sample = Market & { yahooSymbol: string; crossValidate: boolean; latestDate: string };
type FailureType = "TIMEOUT" | "429" | "401" | "403" | "404" | "EMPTY_RESPONSE" | "HTML_PARSE_ERROR" | "CHART_PARSE_ERROR" | "CURRENCY_MISSING" | "TIMEZONE_MISSING" | "ADJUSTED_CLOSE_MISSING" | "VOLUME_MISSING" | "TRADE_DATE_MISSING" | "STALE_DATA" | "UNKNOWN";
type Checkpoint = { completed: string[]; lastSymbol?: string; updatedAt: string };
type Result = {
  yahooTicker: string; exchange: string; country: string; requestMethod: "YAHOO_HTML"; httpStatus: number | null; responseType: string | null;
  tradeDate: string | null; open: number | null; high: number | null; low: number | null; close: number | null; adjustedClose: number | null; volume: number | null;
  currency: string | null; timezone: string | null; latestAvailableDate: string | null; parserVersion: string; validationResult: "PASS" | "FAIL";
  failureReason?: string; failureType?: FailureType; latencyMs: number; crossValidation: "PASS" | "FAIL" | "NOT_SELECTED"; chartHttpStatus: number | null;
};

type YahooScreenerQuote = {
  symbol?: string;
  exchange?: string;
  regularMarketPrice?: number | null;
  regularMarketVolume?: number | null;
  longName?: string | null;
  shortName?: string | null;
};

const MARKETS: Market[] = [
  { name: "AMEX", country: "US", amex: true }, { name: "Japan", country: "Japan", suffix: ".T", region: "jp", exchanges: ["JPX"] }, { name: "Korea", country: "Korea", suffix: ".KS", region: "kr", exchanges: ["KSC"] },
  { name: "Hong Kong", country: "Hong Kong", suffix: ".HK", region: "hk", exchanges: ["HKG"] }, { name: "Canada", country: "Canada", suffix: ".TO", region: "ca", exchanges: ["TOR"] }, { name: "Australia", country: "Australia", suffix: ".AX", region: "au", exchanges: ["ASX"] },
  { name: "Germany", country: "Germany", suffix: ".DE", region: "de", exchanges: ["GER", "FRA"] }, { name: "United Kingdom", country: "United Kingdom", suffix: ".L", region: "gb", exchanges: ["LSE"] }, { name: "France", country: "France", suffix: ".PA", region: "fr", exchanges: ["PAR"] },
  { name: "Spain", country: "Spain", suffix: ".MC", region: "es", exchanges: ["MCE"] }, { name: "Italy", country: "Italy", suffix: ".MI", region: "it", exchanges: ["MIL"] }, { name: "Netherlands", country: "Netherlands", suffix: ".AS", region: "nl", exchanges: ["AMS"] },
];

const sleep = (milliseconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const toUnix = (date: string) => Math.floor(new Date(`${date}T00:00:00.000Z`).valueOf() / 1_000);
const dateKey = (date: Date) => date.toISOString().slice(0, 10);
const safeName = (symbol: string) => symbol.replace(/[^A-Za-z0-9._-]/g, "_");
const percentile = (values: number[], quantile: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)]! : null;
const localDate = (timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

function random(seedValue: number) {
  let state = seedValue >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seededSample<T>(items: T[], amount: number, marketOffset: number): T[] {
  const shuffled = [...items];
  const next = random(seed + marketOffset * 1009);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(next() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled.slice(0, amount);
}

function classify(error: unknown): FailureType {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return "TIMEOUT";
  if (/\b429\b/.test(message)) return "429";
  if (/\b401\b/.test(message)) return "401";
  if (/\b403\b/.test(message)) return "403";
  if (/\b404\b/.test(message)) return "404";
  if (/HISTORY_TABLE_NOT_FOUND|HTML_PARSE/.test(message)) return "HTML_PARSE_ERROR";
  if (/CHART_PARSE|CHART_EMPTY/.test(message)) return "CHART_PARSE_ERROR";
  if (/CURRENCY_MISSING/.test(message)) return "CURRENCY_MISSING";
  if (/TIMEZONE_MISSING/.test(message)) return "TIMEZONE_MISSING";
  if (/ADJUSTED_CLOSE_MISSING/.test(message)) return "ADJUSTED_CLOSE_MISSING";
  if (/VOLUME_MISSING/.test(message)) return "VOLUME_MISSING";
  if (/TRADE_DATE_MISSING/.test(message)) return "TRADE_DATE_MISSING";
  if (/STALE_DATA/.test(message)) return "STALE_DATA";
  if (/EMPTY_RESPONSE|NO_ROWS/.test(message)) return "EMPTY_RESPONSE";
  return "UNKNOWN";
}

function csv(value: unknown): string { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

// Yahoo's EQUITY Screener category includes certificates, warrants, leveraged
// notes and bonds on several European exchanges.  Stage 1 validates ordinary
// listed shares, so filter by stable quote metadata before random sampling.
// This is intentionally deterministic and applied to the whole candidate pool;
// it never substitutes a hand-picked test list.
function isOrdinaryShareCandidate(quote: YahooScreenerQuote, market: Market): boolean {
  const symbol = quote.symbol ?? "";
  const name = `${quote.longName ?? ""} ${quote.shortName ?? ""}`.trim();
  if (!quote.longName || !name) return false;
  if (/\b(?:certificate|certificat|warrant|turbo|factor|bonus|covered|structured|leveraged|leverage|tracker|exchange[ -]?traded|etf|etc|etn|bond|bds|obligation|notes?)\b|\d(?:\.\d+)?%/i.test(name)) return false;
  if (market.name === "France" && (!/^[A-Z]{1,6}\.PA$/.test(symbol) || /^ACAL/i.test(symbol))) return false;
  if (market.name === "Italy" && (!/^[A-Z]{1,6}\.MI$/.test(symbol) || /^(?:F\d|FD|FALL)/.test(symbol))) return false;
  if (market.name === "Netherlands" && !/^[A-Z]{1,5}\.AS$/.test(symbol)) return false;
  if (market.name === "United Kingdom" && !/^[A-Z]{1,5}\.L$/.test(symbol)) return false;
  if (market.name === "Germany" && !/^[A-Z]{1,6}\.(?:DE|F)$/.test(symbol)) return false;
  return true;
}

async function writeLedger(value: object) { await writeFile(ledgerPath, `${JSON.stringify(value, null, 2)}\n`); }

async function readCheckpoint(): Promise<Checkpoint> {
  if (!flag("resume") || !existsSync(checkpointPath)) return { completed: [], updatedAt: new Date().toISOString() };
  return JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
}

async function amexCandidates(): Promise<string[]> {
  const response = await fetch("https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", { headers: { "User-Agent": "SmartFund Global Price validation contact@smartfund.app", Accept: "text/plain" } });
  if (!response.ok) throw new Error(`AMEX_UNIVERSE_HTTP_${response.status}`);
  return (await response.text()).split(/\r?\n/).slice(1).map((line) => line.split("|")).filter((fields) => {
    const [symbol, name, exchange, , etf, , testIssue] = fields;
    return Boolean(symbol && exchange === "A" && etf !== "Y" && testIssue !== "Y" && !symbol.includes("$") && !/preferred|warrant|right|unit/i.test(name ?? ""));
  }).map((fields) => fields[0]!.trim());
}

async function legacyYahooCandidates(suffix: string): Promise<string[]> {
  const state = JSON.parse(await readFile(checkpointUniversePath, "utf8")) as { completedSymbols?: string[] };
  return [...new Set((state.completedSymbols ?? []).filter((symbol) => symbol.endsWith(suffix)))];
}

async function regionalCandidates(market: Market, marketIndex: number): Promise<string[]> {
  const auth = await getAuth();
  if (!auth || !market.region || !market.suffix) throw new Error(`SCREENER_AUTH_UNAVAILABLE_${market.name}`);
  const endpoint = `https://query2.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(auth.crumb)}&lang=en-US&region=${market.region.toUpperCase()}&formatted=false&corsDomain=finance.yahoo.com`;
  const load = async (offset: number) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "User-Agent": "SmartFund Global Price validation contact@smartfund.app", "Content-Type": "application/json", Cookie: auth.cookie },
      body: JSON.stringify({ offset, size: 250, sortField: "intradaymarketcap", sortType: "desc", quoteType: "equity", query: { operator: "and", operands: [{ operator: "eq", operands: ["region", market.region] }, { operator: "eq", operands: ["quoteType", "EQUITY"] }] }, userId: "", userIdType: "guid" }),
    });
    if (!response.ok) throw new Error(`SCREENER_HTTP_${response.status}_${market.name}`);
    const result = (await response.json())?.finance?.result?.[0];
    if (!result?.quotes) throw new Error(`SCREENER_EMPTY_${market.name}`);
    const symbols = (result.quotes as YahooScreenerQuote[])
      .filter((quote) => typeof quote.symbol === "string" && Boolean(quote.exchange && market.exchanges?.includes(quote.exchange)) && Number(quote.regularMarketPrice) > 0 && Number(quote.regularMarketVolume) > 0 && isOrdinaryShareCandidate(quote, market))
      .map((quote) => quote.symbol!)
      .filter((symbol: string) => {
        const onExpectedSuffix = market.name === "Germany" ? /\.(DE|F)$/.test(symbol) : symbol.endsWith(market.suffix!);
        const primaryListing = market.name !== "United Kingdom" || /^[A-Z][A-Z0-9]{0,5}\.L$/.test(symbol);
        return onExpectedSuffix && primaryListing && (market.name !== "Hong Kong" || /^\d{4}\.HK$/.test(symbol));
      });
    return { total: Number(result.total ?? 0), symbols };
  };
  const first = await load(0);
  const pageSize = 250;
  const maxOffset = Math.max(0, first.total - pageSize);
  const next = random(seed + marketIndex * 2003);
  const offsets = new Set([0]);
  while (offsets.size < Math.min(8, Math.ceil(first.total / pageSize))) offsets.add(Math.floor(next() * (Math.floor(maxOffset / pageSize) + 1)) * pageSize);
  const pages = await Promise.all([...offsets].filter((offset) => offset !== 0).map(load));
  return [...new Set([...(first.symbols ?? []), ...pages.flatMap((page) => page.symbols)])];
}

async function buildSamples(): Promise<{ samples: Sample[]; candidates: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const samples: Sample[] = [];
  for (const [index, market] of MARKETS.entries()) {
    const currentCandidates = market.amex ? await amexCandidates() : await regionalCandidates(market, index);
    // Yahoo's regional screener only returns 78 German .DE listings at the
    // current endpoint.  Extend that one market from the existing Yahoo master
    // inventory so the requested random 100-sample remains possible.
    const candidates = currentCandidates.length >= sampleSize || !market.suffix
      ? currentCandidates
      : [...new Set([...currentCandidates, ...await legacyYahooCandidates(market.suffix)])];
    counts[market.name] = candidates.length;
    if (candidates.length < sampleSize) throw new Error(`INSUFFICIENT_UNIVERSE_${market.name}_${candidates.length}`);
    const selected = seededSample(candidates, sampleSize, index);
    const cross = new Set(seededSample(selected, 10, index + 100));
    samples.push(...selected.map((yahooSymbol) => ({ ...market, yahooSymbol, crossValidate: cross.has(yahooSymbol), latestDate: "2026-07-20" })));
  }
  return { samples, candidates: counts };
}

async function fetchChart(symbol: string, period1: number, period2: number) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`CHART_HTTP_${response.status}`);
  let json: any;
  try { json = JSON.parse(raw); } catch { throw new Error("CHART_PARSE_JSON"); }
  const result = json?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error("CHART_EMPTY_RESPONSE");
  const quote = result.indicators?.quote?.[0] ?? {};
  const timezone = result.meta?.exchangeTimezoneName ?? null;
  const candles = result.timestamp.map((timestamp: number, index: number) => ({ date: dateKey(new Date(timestamp * 1_000)), open: quote.open?.[index] ?? null, high: quote.high?.[index] ?? null, low: quote.low?.[index] ?? null, close: quote.close?.[index] ?? null, adjustedClose: result.indicators?.adjclose?.[0]?.adjclose?.[index] ?? null, volume: quote.volume?.[index] ?? null }));
  const valid = (candle: typeof candles[number]) => candle.open !== null && candle.high !== null && candle.low !== null && candle.close !== null && candle.adjustedClose !== null && candle.volume !== null;
  const candle = [...candles].reverse().find(valid);
  const settledDate = timezone ? localDate(timezone) : null;
  const crossCandle = [...candles].reverse().find((entry) => valid(entry) && (!settledDate || entry.date < settledDate));
  if (!candle || !crossCandle) throw new Error("CHART_EMPTY_RESPONSE");
  return { raw, status: response.status, contentType: response.headers.get("content-type"), currency: result.meta?.currency ?? null, timezone, candle, crossCandle };
}

function latestHtml(rows: YahooHistoryRow[]): YahooHistoryRow {
  const row = rows.at(-1);
  if (!row) throw new Error("EMPTY_RESPONSE");
  if (!row.date) throw new Error("TRADE_DATE_MISSING");
  if (row.volume === null) throw new Error("VOLUME_MISSING");
  if (row.adjustedClose === null) throw new Error("ADJUSTED_CLOSE_MISSING");
  if (![row.open, row.high, row.low, row.close, row.adjustedClose, row.volume].every((value) => value !== null && Number.isFinite(value))) throw new Error("EMPTY_RESPONSE");
  if (row.close <= 0 || row.high! < row.low! || row.volume! < 0) throw new Error("EMPTY_RESPONSE");
  return row;
}

function numericMatch(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= Math.max(0.0051, Math.abs(left) * 0.0001);
}

function matches(html: YahooHistoryRow, chart: { date: string; open: number | null; high: number | null; low: number | null; close: number | null; adjustedClose: number | null; volume: number | null }): boolean {
  return dateKey(html.date) === chart.date && numericMatch(html.open, chart.open) && numericMatch(html.high, chart.high) && numericMatch(html.low, chart.low) && numericMatch(html.close, chart.close) && numericMatch(html.adjustedClose, chart.adjustedClose) && html.volume === chart.volume;
}

async function main() {
  await Promise.all([mkdir(outputDirectory, { recursive: true }), mkdir(htmlDirectory, { recursive: true }), mkdir(chartDirectory, { recursive: true })]);
  const checkpoint = await readCheckpoint();
  const persistedManifest = flag("resume") && existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8")) as { samples: Sample[]; candidates: Record<string, number> }
    : null;
  const { samples, candidates } = persistedManifest ?? await buildSamples();
  if (flag("sample-only")) {
    console.log(JSON.stringify({ stage: 1, sampleSize, seed, candidates, selected: samples.length }, null, 2));
    return;
  }
  if (!flag("resume")) await Promise.all([writeFile(payloadPath, ""), writeFile(failurePath, "")]);
  if (!persistedManifest) await writeFile(manifestPath, `${JSON.stringify({ stage: 1, sampleSize, seed, generatedAt: new Date().toISOString(), candidates, samples }, null, 2)}\n`);
  const todo = samples.filter((item) => !checkpoint.completed.includes(item.yahooSymbol));
  const summary = { stage: 1, mode: "DRY_RUN", seed, sampleSize, concurrency, universe: samples.length, attempted: 0, completed: 0, failed: 0, startedAt: new Date().toISOString(), status: "RUNNING" };
  const results: Result[] = [];
  const latency: number[] = [];
  let cursor = 0;
  let persistence = Promise.resolve();
  const persist = (task: () => Promise<void>) => { persistence = persistence.then(task); return persistence; };
  const processOne = async (sample: Sample) => {
    const started = Date.now();
    summary.attempted += 1;
    let chartStatus: number | null = null;
    try {
      const period1 = toUnix(sample.latestDate);
      const period2 = Math.floor(Date.now() / 1_000) + 86_400;
      const htmlResponse = await provider.fetchHistory(sample.yahooSymbol, period1, period2);
      const parsed = provider.parseHistoryHtml(htmlResponse.html);
      const htmlRows = provider.normalizeRows(parsed.rows).filter((row) => row.date >= new Date(`${sample.latestDate}T00:00:00.000Z`));
      const html = latestHtml(htmlRows);
      const chart = await fetchChart(sample.yahooSymbol, period1, period2);
      chartStatus = chart.status;
      if (!chart.currency) throw new Error("CURRENCY_MISSING");
      if (!chart.timezone) throw new Error("TIMEZONE_MISSING");
      if (dateKey(html.date) < sample.latestDate) throw new Error("STALE_DATA");
      const matchingHtmlRow = htmlRows.find((row) => dateKey(row.date) === chart.crossCandle.date) ?? null;
      const crossValidation = sample.crossValidate ? (matchingHtmlRow && matches(matchingHtmlRow, chart.crossCandle) ? "PASS" : "FAIL") : "NOT_SELECTED";
      if (crossValidation === "FAIL") throw new Error("CROSS_VALIDATION_MISMATCH");
      await Promise.all([
        writeFile(join(htmlDirectory, `${safeName(sample.yahooSymbol)}.html`), htmlResponse.html),
        writeFile(join(chartDirectory, `${safeName(sample.yahooSymbol)}.json`), chart.raw),
      ]);
      const result: Result = { yahooTicker: sample.yahooSymbol, exchange: sample.name, country: sample.country, requestMethod: "YAHOO_HTML", httpStatus: htmlResponse.status, responseType: htmlResponse.contentType, tradeDate: dateKey(html.date), open: html.open, high: html.high, low: html.low, close: html.close, adjustedClose: html.adjustedClose, volume: html.volume, currency: chart.currency, timezone: chart.timezone, latestAvailableDate: chart.candle.date, parserVersion, validationResult: "PASS", latencyMs: Date.now() - started, crossValidation, chartHttpStatus: chart.status };
      results.push(result); latency.push(result.latencyMs); summary.completed += 1;
      await persist(async () => { await appendFile(payloadPath, `${JSON.stringify({ ...result, source: "YAHOO", idempotentKey: `${result.yahooTicker}:${result.tradeDate}` })}\n`); checkpoint.completed.push(sample.yahooSymbol); checkpoint.lastSymbol = sample.yahooSymbol; checkpoint.updatedAt = new Date().toISOString(); await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`); await writeLedger({ ...summary, currentSymbol: sample.yahooSymbol, checkpoint }); });
    } catch (error) {
      const result: Result = { yahooTicker: sample.yahooSymbol, exchange: sample.name, country: sample.country, requestMethod: "YAHOO_HTML", httpStatus: null, responseType: null, tradeDate: null, open: null, high: null, low: null, close: null, adjustedClose: null, volume: null, currency: null, timezone: null, latestAvailableDate: null, parserVersion, validationResult: "FAIL", failureReason: error instanceof Error ? error.message : String(error), failureType: classify(error), latencyMs: Date.now() - started, crossValidation: "NOT_SELECTED", chartHttpStatus: chartStatus };
      results.push(result); latency.push(result.latencyMs); summary.failed += 1;
      await persist(async () => { await appendFile(failurePath, `${JSON.stringify(result)}\n`); await writeLedger({ ...summary, currentSymbol: sample.yahooSymbol, checkpoint }); });
    }
    await sleep(350 + Math.floor(Math.random() * 250));
  };
  const worker = async () => { while (cursor < todo.length) { const current = todo[cursor++]; if (current) await processOne(current); } };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await persistence;
  const allPersisted = await readFile(payloadPath, "utf8").then((text) => text.trim() ? text.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Result) : []);
  const allFailureRecords = await readFile(failurePath, "utf8").then((text) => text.trim() ? text.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Result) : []);
  // A resumed symbol is no longer a failure once its idempotent success payload
  // exists.  Keep the append-only failure ledger for diagnostics, but report the
  // unresolved set only.
  const successfulSymbols = new Set(allPersisted.map((result) => result.yahooTicker));
  const unresolvedFailures = [...new Map(allFailureRecords.filter((result) => !successfulSymbols.has(result.yahooTicker)).map((result) => [result.yahooTicker, result])).values()];
  const perMarket = MARKETS.map((market) => {
    const rows = allPersisted.filter((result) => result.exchange === market.name);
    const failures = unresolvedFailures.filter((result) => result.exchange === market.name);
    const cross = rows.filter((result) => result.crossValidation !== "NOT_SELECTED");
    const attempted = rows.length + failures.length;
    const successRate = attempted ? Number((rows.length / attempted * 100).toFixed(2)) : 0;
    const parserRegression = failures.some((result) => result.failureType === "HTML_PARSE_ERROR");
    const staleData = failures.some((result) => result.failureType === "STALE_DATA");
    return { market: market.name, country: market.country, attempted, completed: rows.length, failed: failures.length, successRate, crossValidation: { selected: cross.length, passed: cross.filter((result) => result.crossValidation === "PASS").length, failed: cross.filter((result) => result.crossValidation === "FAIL").length }, readiness: successRate >= 98 && cross.length === 10 && cross.every((result) => result.crossValidation === "PASS") && !parserRegression && !staleData ? "READY_FOR_STAGE_2" : "NOT_READY" };
  });
  const csvHeader = ["yahooTicker", "exchange", "country", "requestMethod", "httpStatus", "responseType", "tradeDate", "open", "high", "low", "close", "adjustedClose", "volume", "currency", "timezone", "latestAvailableDate", "parserVersion", "validationResult", "failureType", "failureReason", "latencyMs", "crossValidation", "chartHttpStatus"];
  await writeFile(csvPath, `${csvHeader.join(",")}\n${[...allPersisted, ...unresolvedFailures].map((row) => csvHeader.map((field) => csv((row as Record<string, unknown>)[field])).join(",")).join("\n")}\n`);
  const allLatency = [...allPersisted, ...unresolvedFailures].map((result) => result.latencyMs).filter((value): value is number => Number.isFinite(value));
  const report = { ...summary, status: unresolvedFailures.length ? "COMPLETED_WITH_FAILURES" : "COMPLETED", completedAt: new Date().toISOString(), totalCompleted: allPersisted.length, totalFailed: unresolvedFailures.length, successRate: Number((allPersisted.length / Math.max(1, allPersisted.length + unresolvedFailures.length) * 100).toFixed(2)), averageLatencyMs: allLatency.length ? Math.round(allLatency.reduce((sum, value) => sum + value, 0) / allLatency.length) : null, p95LatencyMs: percentile(allLatency, .95), p99LatencyMs: percentile(allLatency, .99), healthScore: Math.round(allPersisted.length / Math.max(1, allPersisted.length + unresolvedFailures.length) * 100), perMarket, failureClassification: Object.fromEntries(Object.entries(unresolvedFailures.reduce<Record<string, number>>((all, item) => { const key = item.failureType ?? "UNKNOWN"; all[key] = (all[key] ?? 0) + 1; return all; }, {})).sort()), checkpoint, artifacts: { manifestPath, payloadPath, csvPath, failurePath, checkpointPath, htmlDirectory, chartDirectory, reportPath } };
  await Promise.all([writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`), writeLedger(report)]);
  console.log(JSON.stringify(report, null, 2));
}

async function closeAndExit() {
  await Promise.race([provider.close(), sleep(10_000)]);
  process.exit(process.exitCode ?? 0);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(closeAndExit);
