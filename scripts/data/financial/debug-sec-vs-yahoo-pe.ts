import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type GoldRow = Record<string, number | null>;
type Split = { date: Date; ratio: number };
type EpsFact = { periodStart: Date | null; periodEnd: Date; value: unknown; publicationDate: Date | null; filingDate: Date | null; sourceFactKey: string; source: string };

const prisma = new PrismaClient();
const csvPath = process.argv.find((value) => value.startsWith("--csv="))?.slice("--csv=".length) ?? "C:\\Users\\Frank\\Downloads\\AAPL_quarterly_valuation_measures.csv";
const outputPath = resolve("debug", "financial", "aapl-sec-yahoo-pe-debug.json");
const sampleYears = [1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020, 2023, 2024];

function parseCsvLine(line: string): string[] {
  const values: string[] = []; let current = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) { const char = line[index]; if (char === '"') { if (quoted && line[index + 1] === '"') { current += char; index += 1; } else quoted = !quoted; } else if (char === "," && !quoted) { values.push(current); current = ""; } else current += char; }
  values.push(current); return values;
}
function numeric(value: string | undefined): number | null { const result = Number((value ?? "").replaceAll(",", "")); return Number.isFinite(result) ? result : null; }
function toIso(value: string): string | null { const [month, day, year] = value.split("/"); return month && day && year ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : null; }
function day(value: Date) { return value.toISOString().slice(0, 10); }
function pct(actual: number | null, expected: number | null) { return actual !== null && expected !== null && expected !== 0 ? Math.abs(actual - expected) / Math.abs(expected) * 100 : null; }
function cumulativeFactors(priceDate: Date, splits: Split[]): number[] {
  const factors = [1]; let factor = 1;
  for (const split of splits.filter((item) => item.date > priceDate)) { factor *= split.ratio; factors.push(factor); }
  return [...new Set(factors)];
}
function splitFactorToDate(periodEnd: Date, target: Date, splitEvents: Split[]) {
  return splitEvents.filter((item) => item.date > periodEnd && item.date <= target).reduce((factor, item) => factor * item.ratio, 1);
}
async function json<T>(url: string): Promise<T> { const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "SmartFund PE basis debugger contact@smartfund.app" } }); if (!response.ok) throw new Error(`YAHOO_SPLIT_HTTP_${response.status}`); return response.json() as Promise<T>; }
async function splits(): Promise<Split[]> {
  const payload = await json<{ chart?: { result?: Array<{ events?: { splits?: Record<string, { date?: number; numerator?: number; denominator?: number }> } }> } }>(`https://query1.finance.yahoo.com/v8/finance/chart/AAPL?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=splits`);
  return Object.values(payload.chart?.result?.[0]?.events?.splits ?? {}).flatMap((item) => { const ratio = Number(item.numerator) / Number(item.denominator); return item.date && Number.isFinite(ratio) && ratio > 0 ? [{ date: new Date(item.date * 1000), ratio }] : []; }).sort((left, right) => left.date.valueOf() - right.date.valueOf());
}
function goldRows(lines: string[]): { dates: string[]; rows: Record<string, GoldRow> } {
  const header = parseCsvLine(lines[0]); const dates = header.slice(1).map(toIso); const rows: Record<string, GoldRow> = {};
  for (const line of lines.slice(1)) { const values = parseCsvLine(line); rows[values[0]] = Object.fromEntries(dates.map((date, index) => [date ?? `COLUMN_${index}`, numeric(values[index + 1])])); }
  return { dates: dates.filter((date): date is string => Boolean(date)), rows };
}
function twentyDates(dates: string[]) {
  const selected: string[] = [];
  for (const year of sampleYears) {
    const candidates = dates.filter((date) => date.startsWith(`${year}-`));
    for (const candidate of [candidates.at(-1), candidates[Math.floor(candidates.length / 2)]]) if (candidate && !selected.includes(candidate)) selected.push(candidate);
  }
  // Gold has only one 1985 quarterly point. Preserve the requested years, then
  // add the first available adjacent period so the audit still has 20 unique rows.
  for (const candidate of dates) if (selected.length < 20 && !selected.includes(candidate)) selected.push(candidate);
  return selected.sort();
}
function classify(yahooPe: number | null, candidates: Array<{ formula: string; value: number | null; splitFactor: number; priceBasis: string }>) {
  const scored = candidates.map((candidate) => ({ ...candidate, differencePercent: pct(candidate.value, yahooPe) })).filter((candidate): candidate is typeof candidate & { differencePercent: number } => candidate.differencePercent !== null).sort((left, right) => left.differencePercent - right.differencePercent);
  const baseline = scored.find((candidate) => candidate.formula === "close / ttmEps") ?? scored[0]; const best = scored[0];
  if (!best || !baseline) return { category: "H_OTHER", proof: "No formula can be evaluated from available data.", best };
  if (best.splitFactor !== 1 && baseline.differencePercent - best.differencePercent >= 10) return { category: "B_SPLIT_ADJUSTMENT", proof: `Split factor ${best.splitFactor} lowers error from ${baseline.differencePercent.toFixed(2)}% to ${best.differencePercent.toFixed(2)}%.`, best };
  if (best.priceBasis !== "close" && baseline.differencePercent - best.differencePercent >= 5) return { category: "A_PRICE_BASIS", proof: `${best.priceBasis} lowers error from ${baseline.differencePercent.toFixed(2)}% to ${best.differencePercent.toFixed(2)}%.`, best };
  if (best.differencePercent < 2) return { category: "MATCH", proof: `Best reproducible formula is within ${best.differencePercent.toFixed(2)}%.`, best };
  return { category: "H_OTHER", proof: `No price/split candidate reaches the required tolerance; best is ${best.differencePercent.toFixed(2)}%.`, best };
}

async function main() {
  const [csv, stock, splitEvents] = await Promise.all([readFile(csvPath, "utf8"), prisma.stock.findFirstOrThrow({ where: { ticker: "AAPL", exchange: { in: ["NASDAQ", "NYSE"] } }, select: { id: true, ticker: true } }), splits()]);
  const { dates, rows } = goldRows(csv.trim().split(/\r?\n/).filter(Boolean)); const selectedDates = twentyDates(dates); const selected = selectedDates.map((value) => new Date(`${value}T00:00:00.000Z`));
  const [prices, quarters, ttms, peFacts, shares] = await Promise.all([
    prisma.stockHistory.findMany({ where: { stockId: stock.id, date: { lte: selected.at(-1) } }, select: { date: true, close: true, adjustedClose: true, source: true, sourceSymbol: true }, orderBy: { date: "asc" } }),
    prisma.stockFinancialFact.findMany({ where: { stockId: stock.id, metric: "eps.diluted.quarter", source: { in: ["SEC_EDGAR_COMPANYFACTS", "SEC_EDGAR_DERIVED"] } }, select: { periodStart: true, periodEnd: true, value: true, publicationDate: true, filingDate: true, sourceFactKey: true, source: true }, orderBy: { periodEnd: "asc" } }) as Promise<EpsFact[]>,
    prisma.stockFinancialFact.findMany({ where: { stockId: stock.id, metric: "eps.diluted.ttm", source: "SEC_EDGAR_DERIVED" }, select: { periodStart: true, periodEnd: true, value: true, publicationDate: true, filingDate: true, sourceFactKey: true, source: true }, orderBy: { periodEnd: "asc" } }) as Promise<EpsFact[]>,
    prisma.stockFinancialFact.findMany({ where: { stockId: stock.id, metric: "valuation.pe.ttm.point_in_time", source: "SEC_EDGAR_PLUS_YAHOO_PRICE" }, select: { periodStart: true, periodEnd: true, value: true, publicationDate: true, filingDate: true, sourceFactKey: true, source: true }, orderBy: { periodEnd: "asc" } }) as Promise<EpsFact[]>,
    prisma.stockFinancialFact.findMany({ where: { stockId: stock.id, metric: { contains: "Shares" }, source: { startsWith: "SEC" } }, select: { periodStart: true, periodEnd: true, value: true, publicationDate: true, filingDate: true, sourceFactKey: true, source: true }, orderBy: { periodEnd: "asc" } }) as Promise<EpsFact[]>,
  ]);
  const rowsOut = selected.map((target) => {
    const targetDay = day(target); const price = prices.filter((item) => item.date <= target).at(-1) ?? null;
    const availableTtm = ttms.filter((item) => item.publicationDate && item.publicationDate <= target).at(-1) ?? null;
    const availableQuarter = quarters.filter((item) => item.publicationDate && item.publicationDate <= target).at(-1) ?? null;
    const latestPe = peFacts.filter((item) => item.periodEnd <= target).at(-1) ?? null;
    const outstanding = shares.filter((item) => item.publicationDate && item.publicationDate <= target).at(-1) ?? null;
    const ttmComponents = availableTtm ? quarters.filter((item) => item.periodEnd <= availableTtm.periodEnd && item.publicationDate && item.publicationDate <= target).slice(-4).map((item) => {
      const splitFactor = splitFactorToDate(item.periodEnd, target, splitEvents);
      return { periodStart: item.periodStart ? day(item.periodStart) : null, periodEnd: day(item.periodEnd), rawEps: Number(item.value), splitFactorToTarget: splitFactor, normalizedEps: Number(item.value) / splitFactor, publicationDate: item.publicationDate ? day(item.publicationDate) : null, filingDate: item.filingDate ? day(item.filingDate) : null, source: item.source, sourceFactKey: item.sourceFactKey };
    }) : [];
    const close = price ? Number(price.close) : null; const adjustedClose = price?.adjustedClose === null || price?.adjustedClose === undefined ? null : Number(price.adjustedClose); const ttmEps = availableTtm ? Number(availableTtm.value) : null;
    const factors = price ? cumulativeFactors(price.date, splitEvents) : [1]; const candidates = price && ttmEps && ttmEps > 0 ? factors.flatMap((splitFactor) => [
      { formula: "close / ttmEps", value: close! / ttmEps, splitFactor, priceBasis: "close" },
      { formula: "adjustedClose / ttmEps", value: adjustedClose === null ? null : adjustedClose / ttmEps, splitFactor, priceBasis: "adjustedClose" },
      { formula: "close * splitFactor / ttmEps", value: close! * splitFactor / ttmEps, splitFactor, priceBasis: "close" },
      { formula: "adjustedClose * splitFactor / ttmEps", value: adjustedClose === null ? null : adjustedClose * splitFactor / ttmEps, splitFactor, priceBasis: "adjustedClose" },
    ]) : [];
    const yahooPe = rows.PeRatio?.[targetDay] ?? null; const classification = classify(yahooPe, candidates);
    const priceAdjusted = close !== null && classification.best ? close * classification.best.splitFactor : null;
    const normalizedTtmFromComponents = ttmComponents.length === 4 ? ttmComponents.reduce((sum, component) => sum + component.normalizedEps, 0) : null;
    const goldImpliedTtmEps = yahooPe && priceAdjusted ? priceAdjusted / yahooPe : null;
    return { date: targetDay, yahooPe, secPeStored: latestPe ? Number(latestPe.value) : null, differencePercent: pct(latestPe ? Number(latestPe.value) : null, yahooPe), yahooPrice: price ? Number(price.close) : null, databasePrice: close, priceSource: price?.source ?? null, sourceSymbol: price?.sourceSymbol ?? null, adjustedClose, close, splitFactorsTested: factors, outstandingShares: outstanding ? Number(outstanding.value) : null, quarterEps: availableQuarter ? Number(availableQuarter.value) : null, ttmEps, goldImpliedTtmEps, ttmCalculation: ttmComponents, normalizedTtmFromComponents, quarterEnd: availableTtm ? day(availableTtm.periodEnd) : null, filingDate: availableTtm?.filingDate ? day(availableTtm.filingDate) : null, acceptedDate: availableTtm?.publicationDate ? day(availableTtm.publicationDate) : null, latestAvailableFilingOnThatDate: availableTtm?.sourceFactKey ?? null, sharesAdjusted: null, epsAdjusted: normalizedTtmFromComponents, priceAdjusted, calculatedPe: classification.best?.value ?? null, calculationFormula: classification.best?.formula ?? null, errorClassification: classification.category, proof: classification.proof, formulaCandidates: candidates.map((candidate) => ({ ...candidate, differencePercent: pct(candidate.value, yahooPe) })) };
  });
  const report = { generatedAt: new Date().toISOString(), ticker: "AAPL", csvPath, selectedDates, source: { yahooGoldCsv: "PeRatio", sec: "companyfacts + submissions acceptance time", prices: "existing stock_history", splits: "Yahoo chart split events" }, splitEvents: splitEvents.map((item) => ({ date: day(item.date), ratio: item.ratio })), rows: rowsOut };
  await mkdir(resolve("debug", "financial"), { recursive: true }); await writeFile(outputPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ outputPath, selectedDates, rows: rowsOut }, null, 2));
}
main().finally(() => prisma.$disconnect());
