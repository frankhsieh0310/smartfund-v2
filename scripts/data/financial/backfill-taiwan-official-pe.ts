import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type Exchange = "TWSE" | "TPEx";
type Target = { id: string; ticker: string; exchange: Exchange; currency: string };
type Checkpoint = { date?: string; processedDates: number; inserted: number; failedDates: number; updatedAt: string };
type Audit = { generatedAt: string; range: { start: string; end: string }; targets: string[]; source: Record<Exchange, string>; responseFields: Record<Exchange, string[]>; samples: Record<string, unknown>; timings: number[]; http: Record<string, number>; checkpoint: Checkpoint };

const prisma = new PrismaClient();
const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, "").split("="); return [key, rest.join("=") || "true"]; }));
const limit = Number(args.get("limit") ?? 100);
const sleepMs = Number(args.get("sleep-ms") ?? 250);
const resume = args.has("resume");
const from = args.get("from") ?? `${new Date().getUTCFullYear() - 5}-01-01`;
const to = args.get("to") ?? new Date().toISOString().slice(0, 10);
const output = resolve("debug", "financial", "taiwan-official-pe");
const checkpointPath = resolve(output, "checkpoint.json");
const auditPath = resolve(output, "audit.json");

const endpoints: Record<Exchange, string> = {
  TWSE: "https://www.twse.com.tw/exchangeReport/BWIBBU_d?response=json&date={date}&selectType=ALL",
  TPEx: "https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json&d={date}&s=EW",
};

function rocDate(iso: string) { const [year, month, day] = iso.split("-").map(Number); return `${year - 1911}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`; }
function isoWeekdays(start: string, end: string): string[] {
  const values: string[] = []; const cursor = new Date(`${start}T00:00:00Z`); const until = new Date(`${end}T00:00:00Z`);
  while (cursor <= until) { const weekday = cursor.getUTCDay(); if (weekday !== 0 && weekday !== 6) values.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return values;
}
function value(input: unknown): number | null {
  const parsed = Number(String(input ?? "").replace(/,/g, "").trim()); return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
async function getCheckpoint(): Promise<Checkpoint> {
  if (!resume) return { processedDates: 0, inserted: 0, failedDates: 0, updatedAt: new Date().toISOString() };
  try { return JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint; } catch { return { processedDates: 0, inserted: 0, failedDates: 0, updatedAt: new Date().toISOString() }; }
}
async function saveCheckpoint(checkpoint: Checkpoint) { checkpoint.updatedAt = new Date().toISOString(); await mkdir(dirname(checkpointPath), { recursive: true }); await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2)); }
async function fetchJson(url: string): Promise<{ status: number; body: unknown; elapsed: number }> {
  const started = Date.now(); const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "SmartFund official PE audit contact@smartfund.app" } });
  const text = await response.text(); let body: unknown; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: response.status, body, elapsed: Date.now() - started };
}
function rowsFor(exchange: Exchange, body: unknown): { fields: string[]; rows: string[][] } {
  if (exchange === "TWSE") { const data = body as { fields?: string[]; data?: string[][] }; return { fields: data.fields ?? [], rows: data.data ?? [] }; }
  const table = (body as { tables?: Array<{ fields?: string[]; data?: string[][] }> }).tables?.[0]; return { fields: table?.fields ?? [], rows: table?.data ?? [] };
}

async function main() {
  const candidateStocks = await prisma.stock.findMany({ where: { isActive: true, exchange: { in: ["TWSE", "TPEx"] } }, select: { id: true, ticker: true, exchange: true, currency: true }, orderBy: [{ exchange: "asc" }, { ticker: "asc" }] }) as Target[];
  const priority = new Map(["2330", "2317"].map((ticker, index) => [ticker, index]));
  const stocks = candidateStocks.sort((left, right) => (priority.get(left.ticker) ?? 99_999) - (priority.get(right.ticker) ?? 99_999) || left.exchange.localeCompare(right.exchange) || left.ticker.localeCompare(right.ticker)).slice(0, limit);
  if (!stocks.length) throw new Error("TAIWAN_STOCK_UNIVERSE_EMPTY");
  const targetByExchange = new Map<Exchange, Map<string, Target>>(["TWSE", "TPEx"].map((exchange) => [exchange, new Map(stocks.filter((stock) => stock.exchange === exchange).map((stock) => [stock.ticker, stock]))]));
  const checkpoint = await getCheckpoint(); const dates = isoWeekdays(from, to); const startIndex = checkpoint.date ? Math.max(0, dates.findIndex((date) => date === checkpoint.date) + 1) : 0;
  const audit: Audit = { generatedAt: new Date().toISOString(), range: { start: from, end: to }, targets: stocks.map((stock) => `${stock.exchange}:${stock.ticker}`), source: endpoints, responseFields: { TWSE: [], TPEx: [] }, samples: {}, timings: [], http: {}, checkpoint };

  for (const date of dates.slice(startIndex)) {
    for (const exchange of ["TWSE", "TPEx"] as const) {
      const targets = targetByExchange.get(exchange)!; if (!targets.size) continue;
      const endpoint = endpoints[exchange].replace("{date}", exchange === "TWSE" ? date.replaceAll("-", "") : rocDate(date));
      try {
        const result = await fetchJson(endpoint); audit.timings.push(result.elapsed); audit.http[String(result.status)] = (audit.http[String(result.status)] ?? 0) + 1;
        if (result.status !== 200) throw new Error(`${exchange}_HTTP_${result.status}`);
        const parsed = rowsFor(exchange, result.body); audit.responseFields[exchange] = parsed.fields;
        const tickerIndex = parsed.fields.indexOf("證券代號") >= 0 ? parsed.fields.indexOf("證券代號") : parsed.fields.indexOf("股票代號");
        const peIndex = parsed.fields.indexOf("本益比"); if (tickerIndex < 0 || peIndex < 0) throw new Error(`${exchange}_UNEXPECTED_SCHEMA:${JSON.stringify(parsed.fields)}`);
        const imports = parsed.rows.flatMap((row) => { const ticker = row[tickerIndex]?.trim(); const pe = value(row[peIndex]); const stock = targets.get(ticker); return stock && pe !== null ? [{ stockId: stock.id, metric: "valuation.pe", periodEnd: new Date(`${date}T00:00:00.000Z`), value: pe, unit: "RATIO", currency: stock.currency, source: `${exchange}_OFFICIAL_BWIBBU`, sourceFactKey: `${exchange}:${ticker}:${date}`, sourceDocumentUrl: endpoint }] : []; });
        if (imports.length) checkpoint.inserted += (await prisma.stockFinancialFact.createMany({ data: imports, skipDuplicates: true })).count;
        for (const ticker of ["2330", "2317", "0050"]) { const row = parsed.rows.find((candidate) => candidate[tickerIndex]?.trim() === ticker); if (row) audit.samples[`${exchange}:${ticker}:${date}`] = Object.fromEntries(parsed.fields.map((field, index) => [field, row[index]])); }
      } catch (error) { checkpoint.failedDates += 1; console.error(JSON.stringify({ status: "DATE_FAILED", exchange, date, error: error instanceof Error ? error.message : String(error) })); }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, sleepMs));
    }
    checkpoint.processedDates += 1; checkpoint.date = date;
    if (checkpoint.processedDates % 10 === 0) { await saveCheckpoint(checkpoint); await mkdir(dirname(auditPath), { recursive: true }); await writeFile(auditPath, JSON.stringify(audit, null, 2)); }
  }
  await saveCheckpoint(checkpoint); await mkdir(dirname(auditPath), { recursive: true }); await writeFile(auditPath, JSON.stringify(audit, null, 2));
  console.log(JSON.stringify({ status: "COMPLETE", universe: stocks.length, range: audit.range, checkpoint, medianLatencyMs: audit.timings.sort((a, b) => a - b)[Math.floor(audit.timings.length / 2)] ?? null, http: audit.http, auditPath }));
}
main().finally(() => prisma.$disconnect());
