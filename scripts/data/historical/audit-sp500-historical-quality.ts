import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

type Mapping = { canonical_symbol: string; provider_symbol: string; availability: string };
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const tickers = (await readFile(join(process.cwd(), "scripts", "sp500.csv"), "utf8")).split(/\r?\n/).slice(1).map((line) => line.split(",")[0]?.trim()).filter((value): value is string => Boolean(value));
  const mappings = await prisma.$queryRawUnsafe<Mapping[]>("SELECT canonical_symbol, provider_symbol, availability FROM provider_symbol_mappings WHERE market = 'SP500' AND provider = 'YAHOO'");
  const map = new Map(mappings.map((entry) => [entry.canonical_symbol, entry]));
  const candidates = [...new Set(tickers.flatMap((ticker) => [ticker, ticker.replaceAll(".", "-"), map.get(ticker)?.provider_symbol].filter((value): value is string => Boolean(value))))];
  const stocks = await prisma.stock.findMany({ where: { country: "US", OR: [{ ticker: { in: candidates } }, { yahooSymbol: { in: candidates } }] }, select: { id: true, ticker: true, yahooSymbol: true } });
  const ids = stocks.map((stock) => stock.id);
  const [missingSource, invalidRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ ticker: string; yahoo_symbol: string }>>("SELECT s.ticker, s.yahoo_symbol FROM stocks s WHERE s.id = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM stock_history h WHERE h.stock_id = s.id AND h.source = 'YAHOO') ORDER BY s.yahoo_symbol", ids),
    prisma.$queryRawUnsafe<Array<{ ticker: string; yahoo_symbol: string; date: Date; open: number | null; high: number | null; low: number | null; close: number; source: string | null }>>("SELECT s.ticker, s.yahoo_symbol, h.date, h.open, h.high, h.low, h.close, h.source FROM stock_history h JOIN stocks s ON s.id = h.stock_id WHERE h.stock_id = ANY($1::text[]) AND (h.close IS NULL OR (h.high IS NOT NULL AND h.low IS NOT NULL AND h.high < h.low) OR (h.high IS NOT NULL AND h.open IS NOT NULL AND h.high < h.open) OR (h.high IS NOT NULL AND h.close IS NOT NULL AND h.high < h.close) OR (h.low IS NOT NULL AND h.open IS NOT NULL AND h.low > h.open) OR (h.low IS NOT NULL AND h.close IS NOT NULL AND h.low > h.close)) ORDER BY s.yahoo_symbol, h.date", ids),
  ]);
  console.log(JSON.stringify({ missingYahooSource: missingSource, invalidOhlcvRows: invalidRows }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
