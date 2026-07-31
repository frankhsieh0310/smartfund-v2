import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type SecUnit = { start?: string; end?: string; val?: number; fy?: number; fp?: string; form?: string; filed?: string; accn?: string; frame?: string };
type FilingArrays = { accessionNumber?: string[]; acceptanceDateTime?: string[]; filingDate?: string[] };
type Quarter = { start: string; end: string; value: number; form: string; filed: string; accepted: string; accession: string; fiscalYear?: number; derivation?: "DIRECT_FILING" | "ANNUAL_MINUS_THREE_QUARTERS" };
type Ttm = Quarter & { ttm: number };
type SplitEvent = { date: Date; ratio: number };
const prisma = new PrismaClient();
const symbols = (process.argv.find((value) => value.startsWith("--symbols="))?.split("=")[1] ?? "AAPL,MSFT,NVDA").split(",").map((value) => value.trim().toUpperCase());
const outputPath = resolve("debug", "financial", "sec-historical-pe-audit.json");

async function json<T>(url: string): Promise<T> { const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "SmartFund historical PE research contact@smartfund.app" } }); if (!response.ok) throw new Error(`SEC_HTTP_${response.status}:${url}`); return response.json() as Promise<T>; }
async function yahooSplitEvents(symbol: string): Promise<SplitEvent[]> {
  const payload = await json<{ chart?: { result?: Array<{ events?: { splits?: Record<string, { date?: number; numerator?: number; denominator?: number }> } }> } }>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=splits`);
  return Object.entries(payload.chart?.result?.[0]?.events?.splits ?? {}).flatMap(([, event]) => {
    const ratio = Number(event.numerator) / Number(event.denominator); const timestamp = event.date;
    return timestamp && Number.isFinite(ratio) && ratio > 0 ? [{ date: new Date(timestamp * 1000), ratio }] : [];
  }).sort((a, b) => a.date.valueOf() - b.date.valueOf());
}
function restorePreSplitClose(close: number, priceDate: Date, splits: SplitEvent[]) { return close * splits.filter((split) => split.date > priceDate).reduce((factor, split) => factor * split.ratio, 1); }
function date(input: string) { return new Date(`${input.slice(0, 10)}T00:00:00.000Z`); }
function availabilityDate(acceptedAt: string) {
  const result = date(acceptedAt); const time = acceptedAt.match(/T(\d{2}):(\d{2})/);
  if (time && (Number(time[1]) > 16 || (Number(time[1]) === 16 && Number(time[2]) > 0))) result.setUTCDate(result.getUTCDate() + 1);
  return result;
}
function splitFactorBetween(periodEnd: string, asOf: Date, splits: SplitEvent[]) {
  const periodEndDate = date(periodEnd);
  return splits.filter((split) => split.date > periodEndDate && split.date <= asOf).reduce((factor, split) => factor * split.ratio, 1);
}
function durationDays(item: SecUnit) { return item.start && item.end ? Math.round((date(item.end).valueOf() - date(item.start).valueOf()) / 86_400_000) + 1 : 0; }
// Point-in-time valuation must use the first filing that made a period public.
// Later annual reports repeat comparative quarters; treating those as a new source
// fact introduces future information into earlier P/E calculations.
function firstFiled(a: SecUnit, b: SecUnit) { return String(a.filed ?? "") <= String(b.filed ?? "") ? a : b; }
function standaloneQuarters(items: SecUnit[], acceptance: Map<string, string>, splits: SplitEvent[]): Quarter[] {
  const latest = new Map<string, SecUnit>();
  for (const item of items.filter((item) => item.start && item.end && typeof item.val === "number" && ["10-Q", "10-K"].includes(item.form ?? ""))) { const key = `${item.start}:${item.end}`; latest.set(key, latest.has(key) ? firstFiled(latest.get(key)!, item) : item); }
  const base = [...latest.values()].sort((a, b) => String(a.end).localeCompare(String(b.end)));
  const result: Quarter[] = [];
  for (const item of base) {
    const days = durationDays(item); const accepted = acceptance.get(item.accn ?? "") ?? item.filed ?? ""; if (!accepted || !item.start || !item.end || typeof item.val !== "number") continue;
    // A 10-K may repeat a prior quarter as a comparative duration.  It is not
    // a contemporaneously filed standalone quarter.  Q4 is derived below from
    // the original annual fact and the three actually filed 10-Q quarters.
    if (item.form === "10-Q" && days >= 70 && days <= 115) result.push({ start: item.start, end: item.end, value: item.val, form: item.form!, filed: item.filed!, accepted, accession: item.accn ?? "", fiscalYear: item.fy, derivation: "DIRECT_FILING" });
  }
  for (const item of base) {
    const days = durationDays(item); const accepted = acceptance.get(item.accn ?? "") ?? item.filed ?? "";
    if (days < 300 || days > 420 || !accepted || !item.start || !item.end || typeof item.val !== "number") continue;
    const annualAvailability = availabilityDate(accepted);
    const contained = result
      .filter((quarter) => quarter.start >= item.start! && quarter.end <= item.end! && availabilityDate(quarter.accepted) <= annualAvailability)
      .sort((a, b) => a.end.localeCompare(b.end));
    if (contained.length !== 3 || result.some((quarter) => quarter.end === item.end)) continue;
    // The annual filing is stated on the per-share basis in force when it was
    // filed. Earlier 10-Qs can predate an intervening split (AAPL's 2014
    // seven-for-one split is the regression case). Normalize the annual fact
    // and its first three quarters to that same filing-day basis before
    // deriving Q4. Mixing raw and post-split values creates a false negative
    // EPS and a materially wrong P/E.
    const availableAt = annualAvailability;
    const annualValue = item.val / splitFactorBetween(item.end, availableAt, splits);
    const priorValue = contained.reduce((sum, quarter) => sum + quarter.value / splitFactorBetween(quarter.end, availableAt, splits), 0);
    const value = annualValue - priorValue;
    if (!Number.isFinite(value)) continue;
    const start = new Date(`${contained.at(-1)!.end}T00:00:00Z`); start.setUTCDate(start.getUTCDate() + 1);
    result.push({ start: start.toISOString().slice(0, 10), end: item.end, value, form: item.form!, filed: item.filed!, accepted, accession: item.accn ?? "", fiscalYear: item.fy, derivation: "ANNUAL_MINUS_THREE_QUARTERS" });
  }
  return result.sort((a, b) => a.end.localeCompare(b.end));
}
function isContinuous(quarters: Quarter[]) {
  return quarters.length === 4 && quarters.every((quarter, index) => {
    if (index === 0) return true;
    const prior = date(quarters[index - 1].end);
    const current = date(quarter.end);
    const days = Math.round((current.valueOf() - prior.valueOf()) / 86_400_000);
    return days >= 70 && days <= 115;
  });
}
function pointInTimeTtm(quarters: Quarter[], asOf: Date, splits: SplitEvent[]): Ttm | null {
  const available = quarters.filter((quarter) => availabilityDate(quarter.accepted) <= asOf).sort((a, b) => a.end.localeCompare(b.end));
  const latest = available.slice(-4);
  if (!isContinuous(latest)) return null;
  return { ...latest.at(-1)!, ttm: latest.reduce((sum, quarter) => sum + quarter.value / splitFactorBetween(quarter.end, asOf, splits), 0) };
}

async function main() {
  const [tickers, stocks] = await Promise.all([
    json<Record<string, { ticker: string; cik_str: number }>>("https://www.sec.gov/files/company_tickers.json"),
    prisma.stock.findMany({ where: { ticker: { in: symbols }, exchange: { in: ["NASDAQ", "NYSE", "AMEX"] } }, select: { id: true, ticker: true, currency: true } }),
  ]);
  const cik = new Map(Object.values(tickers).map((item) => [item.ticker.toUpperCase(), String(item.cik_str).padStart(10, "0")])); const report: Record<string, unknown> = {};
  for (const stock of stocks) {
    const id = cik.get(stock.ticker); if (!id) { report[stock.ticker] = { status: "SEC_CIK_NOT_FOUND" }; continue; }
    const [facts, submissions, prices, splits] = await Promise.all([
      json<{ facts?: { "us-gaap"?: Record<string, { units?: Record<string, SecUnit[]> }> } }>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`),
      json<{ filings?: { recent?: FilingArrays } }>(`https://data.sec.gov/submissions/CIK${id}.json`),
      prisma.stockHistory.findMany({ where: { stockId: stock.id }, select: { date: true, close: true }, orderBy: { date: "asc" } }),
      yahooSplitEvents(stock.ticker),
    ]);
    const recent = submissions.filings?.recent ?? {};
    const accepted = new Map((recent.accessionNumber ?? []).flatMap((accession, index) => {
      const acceptedAt = recent.acceptanceDateTime?.[index];
      return accession && acceptedAt ? [[accession, acceptedAt] as const] : [];
    }));
    const eps = facts.facts?.["us-gaap"]?.EarningsPerShareDiluted?.units?.["USD/shares"] ?? [];
    const quarters = standaloneQuarters(eps, accepted, splits);
    const ttms = quarters.flatMap((quarter) => {
      const asOf = availabilityDate(quarter.accepted);
      const ttm = pointInTimeTtm(quarters, asOf, splits);
      return ttm && ttm.end === quarter.end ? [ttm] : [];
    });
    const epsRows = quarters.map((item) => ({ stockId: stock.id, metric: "eps.diluted.quarter", periodStart: date(item.start), periodEnd: date(item.end), fiscalPeriod: "QUARTER", formType: item.form, filingDate: date(item.filed), publicationDate: availabilityDate(item.accepted), value: item.value, unit: "USD_PER_SHARE", currency: "USD", source: item.derivation === "ANNUAL_MINUS_THREE_QUARTERS" ? "SEC_EDGAR_DERIVED" : "SEC_EDGAR_COMPANYFACTS", sourceFactKey: `${id}:eps-quarter:${item.end}:${item.accession}:${item.derivation}`, sourceDocumentUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`, restatementVersion: item.filed }));
    const ttmRows = ttms.map((item) => ({ stockId: stock.id, metric: "eps.diluted.ttm", periodEnd: date(item.end), fiscalPeriod: "TTM", formType: item.form, filingDate: date(item.filed), publicationDate: availabilityDate(item.accepted), value: item.ttm, unit: "USD_PER_SHARE", currency: "USD", source: "SEC_EDGAR_DERIVED", sourceFactKey: `${id}:eps-ttm:${item.end}:${item.accepted}:split-normalized`, sourceDocumentUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`, restatementVersion: item.filed }));
    const peRows = prices.flatMap((price) => {
      const available = pointInTimeTtm(quarters, price.date, splits);
      const close = restorePreSplitClose(Number(price.close), price.date, splits);
      return available && available.ttm > 0 && Number.isFinite(close) ? [{ stockId: stock.id, metric: "valuation.pe.ttm.point_in_time", periodEnd: price.date, fiscalPeriod: "DAILY", publicationDate: availabilityDate(available.accepted), value: close / available.ttm, unit: "RATIO", currency: "USD", source: "SEC_EDGAR_PLUS_YAHOO_PRICE", sourceFactKey: `${id}:pe:${price.date.toISOString().slice(0, 10)}:${available.accepted}`, sourceDocumentUrl: "SEC companyfacts + original filings + split-normalized Yahoo price history" }] : [];
    });
    await prisma.stockFinancialFact.deleteMany({ where: { stockId: stock.id, source: { in: ["SEC_EDGAR_DERIVED", "SEC_EDGAR_PLUS_YAHOO_PRICE"] }, metric: { in: ["eps.diluted.quarter", "eps.diluted.ttm", "valuation.pe.ttm.point_in_time"] } } });
    await prisma.stockFinancialFact.deleteMany({ where: { stockId: stock.id, source: "SEC_EDGAR_COMPANYFACTS", metric: "eps.diluted.quarter" } });
    const [insertedEps, insertedTtm, insertedPe] = await Promise.all([prisma.stockFinancialFact.createMany({ data: epsRows, skipDuplicates: true }), prisma.stockFinancialFact.createMany({ data: ttmRows, skipDuplicates: true }), prisma.stockFinancialFact.createMany({ data: peRows, skipDuplicates: true })]);
    report[stock.ticker] = { cik: id, quarterEps: quarters.length, ttmEps: ttms.length, priceRows: prices.length, splitEvents: splits.length, pointInTimePe: peRows.length, inserted: { eps: insertedEps.count, ttm: insertedTtm.count, pe: insertedPe.count }, earliestQuarter: quarters.at(0)?.end ?? null, latestQuarter: quarters.at(-1)?.end ?? null, latestTtm: ttms.at(-1)?.ttm ?? null, yahooGoldComparison: "NOT_RUN_NO_GOLD_CSV_INPUT" };
  }
  await mkdir(resolve("debug", "financial"), { recursive: true }); await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), symbols, report }, null, 2)); console.log(JSON.stringify({ status: "COMPLETE", outputPath, report }));
}
main().finally(() => prisma.$disconnect());
