import { prisma } from "@/lib/prisma";
import { fetchYahooChartPeriod } from "@/lib/services/dataProviders/yahoo/yahooClient";

const DAY = 86_400_000;
const dateKey = (value: Date) => value.toISOString().slice(0, 10);
const utcDate = (value: Date) => new Date(`${dateKey(value)}T00:00:00.000Z`);

async function chart(symbol: string, from: Date) {
  return fetchYahooChartPeriod(symbol, Math.floor((from.getTime() - 3 * DAY) / 1000), Math.floor((Date.now() + DAY) / 1000));
}

function periodReturn(rows: Array<{ date: Date; price: number }>, days: number): number | null {
  const latest = rows.at(-1);
  if (!latest) return null;
  const target = latest.date.getTime() - days * DAY;
  const base = [...rows].reverse().find((row) => row.date.getTime() <= target);
  return base?.price ? ((latest.price / base.price) - 1) * 100 : null;
}

export async function updateCurrentPrices(limit = 40) {
  const [stocks, etfs] = await Promise.all([
    prisma.stock.findMany({ where: { isActive: true, exchange: { in: ["TWSE", "TPEx", "TPEX"] }, yahooSymbol: { not: "" } }, orderBy: { updatedAt: "asc" }, take: limit, select: { id: true, yahooSymbol: true, latestDate: true } }),
    prisma.etf.findMany({ where: { isActive: true, currency: "TWD", dataSource: { not: null } }, orderBy: { priceUpdatedAt: "asc" }, take: limit, select: { id: true, dataSource: true, priceUpdatedAt: true } }),
  ]);
  let stockUpdated = 0, etfUpdated = 0;
  const failures: Array<{ kind: string; symbol: string; reason: string }> = [];
  for (const stock of stocks) try {
    const from = stock.latestDate ?? new Date(Date.now() - 10 * DAY), response = await chart(stock.yahooSymbol, from);
    const rows = response?.candles.filter((row) => row.close != null && row.close > 0) ?? [], latest = rows.at(-1);
    if (!latest) continue;
    for (const row of rows) await prisma.stockHistory.upsert({ where: { stockId_date: { stockId: stock.id, date: utcDate(row.date) } }, create: { stockId: stock.id, date: utcDate(row.date), open: row.open, high: row.high, low: row.low, close: row.close!, adjustedClose: row.adjClose, volume: row.volume, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_CHART_CRON", importedAt: new Date(), updatedAt: new Date() }, update: { open: row.open, high: row.high, low: row.low, close: row.close!, adjustedClose: row.adjClose, volume: row.volume, updatedAt: new Date() } });
    await prisma.stock.update({ where: { id: stock.id }, data: { latestDate: utcDate(latest.date), latestClose: latest.close } }); stockUpdated++;
  } catch (error) { failures.push({ kind: "STOCK", symbol: stock.yahooSymbol, reason: String(error) }); }
  for (const etf of etfs) try {
    const symbol = etf.dataSource!, response = await chart(symbol, etf.priceUpdatedAt ?? new Date(Date.now() - 1100 * DAY));
    const candles = response?.candles.filter((row) => row.close != null && row.close > 0) ?? [], latest = candles.at(-1);
    if (!latest) continue;
    for (const row of candles) await prisma.etfHistory.upsert({ where: { etfId_date: { etfId: etf.id, date: utcDate(row.date) } }, create: { etfId: etf.id, date: utcDate(row.date), price: row.close, open: row.open, high: row.high, low: row.low, close: row.close, adjustedClose: row.adjClose, volume: row.volume, source: "YAHOO", sourceUrl: symbol, knownAt: new Date() }, update: { price: row.close, open: row.open, high: row.high, low: row.low, close: row.close, adjustedClose: row.adjClose, volume: row.volume, knownAt: new Date() } });
    const history = (await prisma.etfHistory.findMany({ where: { etfId: etf.id, price: { not: null } }, orderBy: { date: "desc" }, take: 1100, select: { date: true, price: true } })).reverse();
    const points = history.filter((x) => x.price != null).map(x => ({ date: x.date, price: Number(x.price) }));
    await prisma.etfPerformance.upsert({ where: { etfId_date: { etfId: etf.id, date: utcDate(latest.date) } }, create: { etfId: etf.id, date: utcDate(latest.date), price: latest.close, return1d: periodReturn(points, 1), return1m: periodReturn(points, 30), return3m: periodReturn(points, 91), return6m: periodReturn(points, 183), return1y: periodReturn(points, 365), return3y: periodReturn(points, 1096) }, update: { price: latest.close, return1d: periodReturn(points, 1), return1m: periodReturn(points, 30), return3m: periodReturn(points, 91), return6m: periodReturn(points, 183), return1y: periodReturn(points, 365), return3y: periodReturn(points, 1096) } });
    await prisma.etf.update({ where: { id: etf.id }, data: { latestPrice: latest.close, priceUpdatedAt: utcDate(latest.date) } }); etfUpdated++;
  } catch (error) { failures.push({ kind: "ETF", symbol: etf.dataSource ?? etf.id, reason: String(error) }); }
  return { stockAttempted: stocks.length, stockUpdated, etfAttempted: etfs.length, etfUpdated, failures };
}
