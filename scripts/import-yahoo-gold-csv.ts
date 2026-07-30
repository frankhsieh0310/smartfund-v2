import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import Papa from "papaparse";
import { PrismaClient } from "@prisma/client";

type CsvRow = Record<string, string>;
type ImportedFact = { metric: string; periodEnd: Date; value: number; unit: string };
export type GoldImportResult = { file: string; symbol: string; parsedRows: number; inserted: number; readBack: number; checksum: string };

function dateFrom(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function numericFrom(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/[$,%\s,]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (["--", "N/A", "null", "-"].includes(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function metricName(value: string): string {
  return value.trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function unitFor(metric: string): string {
  if (/eps|per_share|dividend/.test(metric)) return "PER_SHARE";
  if (/margin|yield|ratio|roe|roa|roic|growth|return/.test(metric)) return "RATIO";
  if (/shares|float/.test(metric)) return "SHARES";
  return "VALUE";
}

function dateColumn(headers: string[]): string | undefined {
  return headers.find((header) => /^(date|as of date|period end|period)$/i.test(header.trim()));
}

function parseFacts(rows: CsvRow[]): ImportedFact[] {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);
  const metricColumn = headers.find((header) => /^(metric|breakdown|description|name)$/i.test(header.trim()));
  const datedColumns = headers.map((header) => ({ header, date: dateFrom(header) })).filter((item): item is { header: string; date: Date } => item.date !== null);
  if (metricColumn && datedColumns.length) {
    return rows.flatMap((row) => datedColumns.flatMap(({ header, date }) => {
      const metric = metricName(row[metricColumn] ?? "");
      const value = numericFrom(row[header]);
      return metric && value !== null ? [{ metric, periodEnd: date, value, unit: unitFor(metric) }] : [];
    }));
  }
  const dateKey = dateColumn(headers);
  if (!dateKey) return [];
  return rows.flatMap((row) => {
    const periodEnd = dateFrom(row[dateKey] ?? "");
    if (!periodEnd) return [];
    return headers.flatMap((header) => {
      if (header === dateKey) return [];
      const metric = metricName(header);
      const value = numericFrom(row[header]);
      return metric && value !== null ? [{ metric, periodEnd, value, unit: unitFor(metric) }] : [];
    });
  });
}

export async function importYahooGoldCsv(file: string, symbol: string): Promise<GoldImportResult> {
  const csv = await readFile(file, "utf8");
  const checksum = createHash("sha256").update(csv).digest("hex");
  const parsed = Papa.parse<CsvRow>(csv, { header: true, skipEmptyLines: "greedy" });
  if (parsed.errors.length) throw new Error(`CSV_PARSE_ERROR:${parsed.errors[0].message}`);
  const facts = parseFacts(parsed.data);
  if (!facts.length) throw new Error("CSV_SCHEMA_UNSUPPORTED:no dated metric values found");
  const prisma = new PrismaClient();
  try {
    const stock = await prisma.stock.findUnique({ where: { yahooSymbol: symbol }, select: { id: true, currency: true } });
    if (!stock) throw new Error(`STOCK_NOT_FOUND:${symbol}`);
    const fileKey = `${checksum}:${basename(file)}`;
    const inserted = await prisma.stockFinancialFact.createMany({
      data: facts.map((fact) => ({
        stockId: stock.id,
        metric: `yahoo.gold.${metricName(basename(file))}.${fact.metric}`,
        periodEnd: fact.periodEnd,
        value: fact.value,
        unit: fact.unit,
        currency: stock.currency,
        source: "YAHOO_GOLD_CSV",
        sourceFactKey: `${fileKey}:${fact.metric}`,
        sourceDocumentUrl: `file:${basename(file)}`,
      })),
      skipDuplicates: true,
    });
    const readBack = await prisma.stockFinancialFact.count({ where: { stockId: stock.id, source: "YAHOO_GOLD_CSV", sourceFactKey: { startsWith: fileKey } } });
    if (readBack !== facts.length) throw new Error(`READ_BACK_MISMATCH:expected=${facts.length}:actual=${readBack}`);
    return { file, symbol, parsedRows: parsed.data.length, inserted: inserted.count, readBack, checksum };
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const [file, symbol] = process.argv.slice(2);
  if (!file || !symbol) throw new Error("Usage: import-yahoo-gold-csv.ts <file> <symbol>");
  console.log(JSON.stringify(await importYahooGoldCsv(file, symbol)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
