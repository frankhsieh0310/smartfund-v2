import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const csvPath = process.argv.find((value) => value.startsWith("--csv="))?.slice("--csv=".length);
if (!csvPath) throw new Error("CSV_PATH_REQUIRED: pass --csv=<Yahoo Gold valuation CSV>");

function parseLine(line: string): string[] {
  const values: string[] = []; let current = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) { const character = line[index]; if (character === '"') { if (quoted && line[index + 1] === '"') { current += '"'; index += 1; } else quoted = !quoted; } else if (character === "," && !quoted) { values.push(current); current = ""; } else current += character; }
  values.push(current); return values;
}
function number(value: string | undefined) { const parsed = Number((value ?? "").replaceAll(",", "")); return Number.isFinite(parsed) ? parsed : null; }
function normalizeDate(value: string) { const [month, day, year] = value.split("/"); return month && day && year ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : null; }

async function main() {
  const lines = (await readFile(csvPath, "utf8")).trim().split(/\r?\n/).filter(Boolean); const header = parseLine(lines[0]);
  const peRow = lines.slice(1).map(parseLine).find((row) => row[0] === "PeRatio"); if (!peRow) throw new Error("YAHOO_GOLD_PE_RATIO_ROW_NOT_FOUND");
  const gold = new Map(header.map((heading, index) => [normalizeDate(heading), number(peRow[index])]).filter((entry): entry is [string, number] => Boolean(entry[0]) && entry[1] !== null));
  const stock = await prisma.stock.findFirstOrThrow({ where: { ticker: "AAPL", exchange: { in: ["NASDAQ", "NYSE"] } }, select: { id: true } });
  const calculated = await prisma.stockFinancialFact.findMany({ where: { stockId: stock.id, metric: "valuation.pe.ttm.point_in_time", source: "SEC_EDGAR_PLUS_YAHOO_PRICE" }, select: { periodEnd: true, value: true, publicationDate: true }, orderBy: { periodEnd: "asc" } });
  const pairs = calculated.flatMap((item) => { const date = item.periodEnd.toISOString().slice(0, 10); const reference = gold.get(date); const actual = Number(item.value); return reference !== undefined ? [{ date, yahooGoldPe: reference, secPointInTimePe: actual, absoluteDifference: Math.abs(actual - reference), absolutePercentError: reference !== 0 ? Math.abs(actual - reference) / Math.abs(reference) * 100 : null, secPublicationDate: item.publicationDate?.toISOString().slice(0, 10) ?? null }] : []; });
  const errors = pairs.map((item) => item.absolutePercentError).filter((value): value is number => value !== null);
  const report = { generatedAt: new Date().toISOString(), csvPath, yahooGold: { metric: "PeRatio", dates: gold.size, earliest: [...gold.keys()].sort().at(0) ?? null, latest: [...gold.keys()].sort().at(-1) ?? null }, secPointInTime: { dates: calculated.length, earliest: calculated.at(0)?.periodEnd.toISOString().slice(0, 10) ?? null, latest: calculated.at(-1)?.periodEnd.toISOString().slice(0, 10) ?? null }, matched: pairs.length, meanAbsolutePercentError: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null, pairs };
  const output = resolve("debug", "financial", "aapl-sec-vs-yahoo-gold-pe.json"); await mkdir(resolve("debug", "financial"), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, pairs: pairs.slice(0, 5), output }));
}
main().finally(() => prisma.$disconnect());
