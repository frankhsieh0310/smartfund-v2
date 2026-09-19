import { prisma } from "../../prisma.ts";
import { WebDataError } from "./errors.ts";
import { freshnessStatus } from "./freshness.ts";
import { normalizePagination, paginationMeta } from "./pagination.ts";
import { buildProvenance } from "./provenance.ts";
import { isoOrNull, numberOrNull, type CanonicalIdentity, type HistoryQuery, type ListQuery, type ServiceResponse, type SummaryMetrics } from "./types.ts";

function identity(row: { id: string; ticker: string; yahooSymbol: string; companyName: string; companyNameZh: string | null; currency: string; exchange: string; country: string }): CanonicalIdentity {
  return { assetType: "STOCK", id: row.id, symbol: row.yahooSymbol || row.ticker, name: row.companyName, displayName: row.companyNameZh ?? row.companyName, currency: row.currency, market: row.exchange, country: row.country };
}

function metrics(row: { latestClose: unknown; latestDate: Date | null; currency: string }): SummaryMetrics {
  return { priceOrNav: numberOrNull(row.latestClose), change: null, changePercent: null, currency: row.currency, asOfDate: isoOrNull(row.latestDate), performance1M: null, performance3M: null, performance1Y: null };
}

export async function getStockList(query: ListQuery = {}): Promise<ServiceResponse<Array<{ identity: CanonicalIdentity; metrics: SummaryMetrics }>>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const term = query.query?.trim();
  const where = { isActive: true, ...(term ? { OR: [{ ticker: { contains: term, mode: "insensitive" as const } }, { yahooSymbol: { contains: term, mode: "insensitive" as const } }, { companyName: { contains: term, mode: "insensitive" as const } }, { companyNameZh: { contains: term, mode: "insensitive" as const } }] } : {}) };
  const [total, rows] = await Promise.all([prisma.stock.count({ where }), prisma.stock.findMany({ where, skip, take: pageSize, orderBy: [{ ticker: "asc" }, { exchange: "asc" }], select: { id: true, ticker: true, yahooSymbol: true, companyName: true, companyNameZh: true, currency: true, exchange: true, country: true, latestClose: true, latestDate: true, updatedAt: true } })]);
  const latest = rows.reduce<Date | null>((value, row) => !value || (row.latestDate && row.latestDate > value) ? row.latestDate : value, null);
  const updated = rows.reduce<Date | null>((value, row) => !value || row.updatedAt > value ? row.updatedAt : value, null);
  const provenance = buildProvenance({ asOfDate: latest, lastUpdated: updated });
  return { data: rows.map((row) => ({ identity: identity(row), metrics: metrics(row) })), meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(latest, "MARKET_DAY"), source: null, provenance, coverageStatus: "FULL" }, pagination: paginationMeta(page, pageSize, total), error: null };
}

export const searchStocks = (query: string, options: Omit<ListQuery, "query"> = {}) => getStockList({ ...options, query });

type StockLiteMetric = { key: string; label: string; value: number | string | null; unit?: string };

const latestFacts = (facts: Array<{ metric: string; value: unknown; unit: string; currency: string | null; periodEnd: Date }>): StockLiteMetric[] => {
  const seen = new Set<string>();
  const labels: Record<string, { key: string; label: string }> = {
    revenue: { key: "revenue", label: "營收" }, basic_eps: { key: "eps", label: "每股盈餘" }, diluted_eps: { key: "dilutedEps", label: "稀釋每股盈餘" }, gross_profit: { key: "grossProfit", label: "毛利" }, operating_income: { key: "operatingIncome", label: "營業利益" }, net_income: { key: "netIncome", label: "淨利" }, total_assets: { key: "totalAssets", label: "總資產" }, total_liabilities: { key: "totalLiabilities", label: "總負債" }, shareholders_equity: { key: "shareholdersEquity", label: "股東權益" }, cash_and_cash_equivalents: { key: "cash", label: "現金及約當現金" }, operating_cash_flow: { key: "operatingCashFlow", label: "營業現金流" }, investing_cash_flow: { key: "investingCashFlow", label: "投資現金流" }, financing_cash_flow: { key: "financingCashFlow", label: "融資現金流" }, capital_expenditure: { key: "capitalExpenditure", label: "資本支出" }, shares_outstanding: { key: "sharesOutstanding", label: "流通股數" }, "valuation.pe.ttm.point_in_time": { key: "pe", label: "本益比" }, "yahoo.event.cashDividend": { key: "dividend", label: "現金股利" },
  };
  const result: StockLiteMetric[] = [];
  for (const fact of facts) { const mapped = labels[fact.metric]; if (!mapped || seen.has(mapped.key)) continue; seen.add(mapped.key); result.push({ ...mapped, value: numberOrNull(fact.value), unit: fact.unit }); }
  if (facts[0]?.periodEnd) result.push({ key: "fundamentalsAsOf", label: "基本面資料日期", value: facts[0].periodEnd.toISOString().slice(0, 10) });
  return result;
};

const analyticMetrics = (rows: Array<{ asOf: Date; timeframe: string; metricKey: string; window: number; value: unknown; stateValue: string | null }>): StockLiteMetric[] => {
  const latest = rows[0]?.asOf?.getTime();
  if (!latest) return [];
  const timeframeLabel: Record<string, string> = { DAILY: "日線", WEEKLY: "週線", MONTHLY: "月線" };
  const metricLabel: Record<string, string> = {
    SMA: "SMA", EMA: "EMA", RSI: "RSI", MACD: "MACD", ROC: "ROC", MOMENTUM: "Momentum",
    REALIZED_VOLATILITY: "歷史波動率", DRAWDOWN: "回撤", ADX: "ADX", PLUS_DI: "+DI", MINUS_DI: "-DI",
    RELATIVE_VOLUME: "相對成交量", VOLUME_ZSCORE: "成交量 Z 分數", BREAKOUT_STATE: "突破／跌破",
    TREND_STATE: "趨勢狀態", MOMENTUM_STATE: "動能狀態", VOLATILITY_STATE: "波動狀態",
    PRICE_VOLUME_STATE: "價量狀態", TIMEFRAME_ALIGNMENT: "多週期綜合",
    DISTANCE_FROM_52W_HIGH: "距 52 週高點", DISTANCE_FROM_52W_LOW: "距 52 週低點",
  };
  const stateLabel = (value: string) => ({
    STRONG_UPTREND: "強勢偏多", UPTREND: "偏多", STRONG_DOWNTREND: "強勢偏空", DOWNTREND: "偏空",
    NEUTRAL: "中性", BULLISH_ALIGNED: "多週期偏多", MOSTLY_BULLISH: "多數週期偏多",
    BEARISH_ALIGNED: "多週期偏空", MOSTLY_BEARISH: "多數週期偏空", MIXED: "週期分歧",
    HIGH_BREAKOUT: "向上突破", LOW_BREAKDOWN: "向下跌破", INPUT_INSUFFICIENT: "資料尚未提供",
  } as Record<string, string>)[value] ?? value.replaceAll("_", " ");
  return rows.filter((row) => row.asOf.getTime() === latest && (row.value != null || row.stateValue)).map((row) => {
    const label = metricLabel[row.metricKey] ?? row.metricKey;
    const percent = ["ROC", "REALIZED_VOLATILITY", "DRAWDOWN", "DISTANCE_FROM_52W_HIGH", "DISTANCE_FROM_52W_LOW"].includes(row.metricKey);
    const value = row.stateValue ? stateLabel(row.stateValue) : numberOrNull(row.value);
    return { key: `analytic_${row.timeframe}_${row.metricKey}_${row.window}`, label: `${timeframeLabel[row.timeframe] ?? row.timeframe} ${label}${row.window ? `（${row.window}）` : ""}`, value: typeof value === "number" && percent ? value * 100 : value, ...(percent ? { unit: "%" } : {}) };
  });
};

export async function getStockDetail(symbol: string): Promise<ServiceResponse<{ identity: CanonicalIdentity; metrics: SummaryMetrics; sector: string | null; industry: string | null; liteMetrics: StockLiteMetric[] }>> {
  const key = decodeURIComponent(symbol).trim();
  if (!key) throw new WebDataError("INVALID_QUERY", "A stock symbol is required.");
  const row = await prisma.stock.findFirst({ where: { OR: [{ id: key }, { yahooSymbol: { equals: key, mode: "insensitive" } }, { ticker: { equals: key, mode: "insensitive" } }] }, select: { id: true, ticker: true, yahooSymbol: true, companyName: true, companyNameZh: true, currency: true, exchange: true, country: true, latestClose: true, latestDate: true, updatedAt: true, sector: true, industry: true, financialFacts: { orderBy: [{ periodEnd: "desc" }, { publicationDate: "desc" }], take: 200, select: { metric: true, value: true, unit: true, currency: true, periodEnd: true } }, versionedAnalytics: { orderBy: [{ asOf: "desc" }, { timeframe: "asc" }, { metricKey: "asc" }], take: 160, select: { asOf: true, timeframe: true, metricKey: true, window: true, value: true, stateValue: true } }, history: { orderBy: { date: "desc" }, take: 2, select: { date: true, close: true, volume: true, source: true, sourceSymbol: true, updatedAt: true, importedAt: true } }, technical: { orderBy: { date: "desc" }, take: 1, select: { date: true, ma5: true, ma20: true, ma60: true, ma120: true, ma240: true, ema12: true, ema26: true, macd: true, macdSignal: true, macdHistogram: true, kdK: true, kdD: true, rsi14: true, atr14: true, bollingerUpper: true, bollingerMiddle: true, bollingerLower: true } } } });
  if (!row) throw new WebDataError("NOT_FOUND", "Stock not found.");
  const latest = row.history[0];
  const previous = row.history[1];
  const asOf = latest?.date ?? row.latestDate;
  const currentPrice = numberOrNull(latest?.close ?? row.latestClose);
  const previousPrice = numberOrNull(previous?.close);
  const change = currentPrice != null && previousPrice != null ? currentPrice - previousPrice : null;
  const changePercent = change != null && previousPrice ? change / previousPrice * 100 : null;
  const technical = row.technical[0];
  const source = latest?.source ?? null;
  const provenance = buildProvenance({ source, sourceRecordId: latest?.sourceSymbol, asOfDate: asOf, lastUpdated: latest?.updatedAt ?? latest?.importedAt ?? row.updatedAt });
  const trend = numberOrNull(technical?.ma20) != null && numberOrNull(technical?.ma60) != null ? (Number(technical?.ma20) >= Number(technical?.ma60) ? "中期趨勢偏多" : "中期趨勢偏空") : null;
  const signal = numberOrNull(technical?.macd) != null && numberOrNull(technical?.macdSignal) != null ? (Number(technical?.macd) >= Number(technical?.macdSignal) ? "MACD 位於訊號線上方" : "MACD 位於訊號線下方") : null;
  return { data: { identity: identity(row), metrics: { ...metrics(row), priceOrNav: currentPrice, change, changePercent, asOfDate: isoOrNull(asOf) }, sector: row.sector, industry: row.industry, liteMetrics: [
    { key: "marketCap", label: "Market Cap", value: null },
    { key: "pe", label: "P/E", value: null },
    { key: "eps", label: "EPS", value: null },
    { key: "dividend", label: "Dividend", value: null },
    { key: "sector", label: "產業類別", value: row.sector }, { key: "industry", label: "所屬產業", value: row.industry }, ...latestFacts(row.financialFacts),
    { key: "trend", label: "趨勢", value: trend }, { key: "ma5", label: "5 日均線", value: numberOrNull(technical?.ma5) }, { key: "ma20", label: "20 日均線", value: numberOrNull(technical?.ma20) }, { key: "ma60", label: "60 日均線", value: numberOrNull(technical?.ma60) }, { key: "ma120", label: "120 日均線", value: numberOrNull(technical?.ma120) }, { key: "ma240", label: "240 日均線", value: numberOrNull(technical?.ma240) }, { key: "ema12", label: "12 日指數均線", value: numberOrNull(technical?.ema12) }, { key: "ema26", label: "26 日指數均線", value: numberOrNull(technical?.ema26) },
    { key: "rsi14", label: "RSI（14）", value: numberOrNull(technical?.rsi14) }, { key: "kdK", label: "KD K 值", value: numberOrNull(technical?.kdK) }, { key: "kdD", label: "KD D 值", value: numberOrNull(technical?.kdD) },
    { key: "macd", label: "MACD", value: numberOrNull(technical?.macd) },
    { key: "macdSignal", label: "MACD 訊號線", value: numberOrNull(technical?.macdSignal) }, { key: "macdHistogram", label: "MACD 柱狀值", value: numberOrNull(technical?.macdHistogram) },
    { key: "atr14", label: "ATR（14）", value: numberOrNull(technical?.atr14) }, { key: "bollingerUpper", label: "布林通道上緣", value: numberOrNull(technical?.bollingerUpper) }, { key: "bollingerMiddle", label: "布林通道中線", value: numberOrNull(technical?.bollingerMiddle) }, { key: "bollingerLower", label: "布林通道下緣", value: numberOrNull(technical?.bollingerLower) },
    { key: "volume", label: "成交量", value: latest?.volume == null ? null : Number(latest.volume) }, { key: "signal", label: "目前訊號", value: signal },
    ...analyticMetrics(row.versionedAnalytics),
    { key: "technicalAsOf", label: "技術資料日期", value: row.versionedAnalytics[0]?.asOf.toISOString().slice(0, 10) ?? technical?.date.toISOString().slice(0, 10) ?? null },
  ] }, meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(asOf, "MARKET_DAY"), source, provenance, coverageStatus: "FULL" }, pagination: null, error: null };
}

export async function getStockHistory(symbol: string, query: HistoryQuery = {}): Promise<ServiceResponse<Array<{ date: string; open: number | null; high: number | null; low: number | null; close: number; adjustedClose: number | null; volume: number | null }>>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const stock = await prisma.stock.findFirst({ where: { OR: [{ yahooSymbol: { equals: symbol, mode: "insensitive" } }, { ticker: { equals: symbol, mode: "insensitive" } }] }, select: { id: true } });
  if (!stock) throw new WebDataError("NOT_FOUND", "Stock not found.");
  const cursorDate = query.cursor ? new Date(query.cursor) : null;
  if (cursorDate && Number.isNaN(cursorDate.getTime())) throw new WebDataError("INVALID_QUERY", "Invalid history cursor.");
  const where = { stockId: stock.id, date: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}), ...(cursorDate ? { lt: cursorDate } : {}) } };
  const [total, rows] = await Promise.all([prisma.stockHistory.count({ where }), prisma.stockHistory.findMany({ where, skip: cursorDate ? 0 : skip, take: pageSize, orderBy: { date: "desc" } })]);
  const latest = rows[0];
  const provenance = buildProvenance({ source: latest?.source, sourceRecordId: latest?.sourceSymbol, asOfDate: latest?.date, lastUpdated: latest?.updatedAt ?? latest?.importedAt ?? latest?.createdAt });
  return { data: rows.map((row) => ({ date: row.date.toISOString(), open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low), close: Number(row.close), adjustedClose: numberOrNull(row.adjustedClose), volume: numberOrNull(row.volume) })), meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(latest?.date, "MARKET_DAY"), source: provenance.source, provenance, coverageStatus: "FULL" }, pagination: paginationMeta(page, pageSize, total, rows.length === pageSize ? rows.at(-1)?.date.toISOString() ?? null : null), error: null };
}
