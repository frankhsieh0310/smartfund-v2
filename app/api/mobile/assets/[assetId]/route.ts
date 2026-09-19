import { prisma } from '@/lib/prisma';
import { errorResponse } from '@/lib/data-platform/web/errors';
import { getEtfDetail, getEtfHistory } from '@/lib/data-platform/web/etfService';
import { getFundDetail, type FundDetailRange } from '@/lib/data-platform/web/fundService';
import { getFxDetail, getFxHistory } from '@/lib/data-platform/web/fxService';
import { getIndexDetail, getIndexHistory } from '@/lib/data-platform/web/indexService';
import { getStockDetail, getStockHistory } from '@/lib/data-platform/web/stockService';
import { getGovernmentYieldDetail } from '@/lib/services/governmentYieldService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }

const PERIOD_DAYS = { '1M': 31, '3M': 93, '6M': 186, '1Y': 366, '3Y': 1096, '5Y': 1827, '10Y': 3653, MAX: null } as const;
type Period = keyof typeof PERIOD_DAYS;
type AssetType = 'STOCK' | 'ETF' | 'FUND' | 'INDEX' | 'FX' | 'MACRO' | 'COMMODITY' | 'CRYPTO' | 'FIXED_INCOME';
type HistoryResponse = Awaited<ReturnType<typeof getStockHistory>> | Awaited<ReturnType<typeof getEtfHistory>> | Awaited<ReturnType<typeof getIndexHistory>> | Awaited<ReturnType<typeof getFxHistory>>;

const fromFor = (period: Period) => { const days = PERIOD_DAYS[period]; return days === null ? undefined : new Date(Date.now() - days * 86_400_000); };
const numberOrNull = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
const sample = <T,>(rows: T[], limit = 240): T[] => rows.length <= limit ? rows : Array.from({ length: limit }, (_, index) => rows[Math.round(index * (rows.length - 1) / (limit - 1))]);
const meta = (asOfDate: Date | null, source: string | null, coverageStatus: 'FULL' | 'PARTIAL_CURRENT' | 'UNKNOWN' = 'FULL') => ({ asOfDate: asOfDate?.toISOString() ?? null, lastUpdated: asOfDate?.toISOString() ?? null, freshnessStatus: asOfDate ? 'CURRENT' as const : 'UNKNOWN' as const, source, coverageStatus });

async function marketDetail(assetId: string, assetType: 'COMMODITY' | 'CRYPTO') {
  const row = await prisma.marketMaster.findFirst({ where: { assetType, OR: [{ id: assetId }, { symbol: { equals: assetId, mode: 'insensitive' } }] } });
  if (!row) throw new Error(`${assetType} not found.`);
  const latest = await prisma.marketData.findFirst({ where: { symbol: row.symbol, type: assetType }, orderBy: { date: 'desc' } });
  const asOf = latest?.date ?? row.latestDate;
  return { data: { identity: { assetType, id: row.id, symbol: row.symbol, name: row.name, displayName: row.nameZh ?? row.name, currency: row.currency, market: row.exchange, country: row.country ?? row.region }, metrics: { priceOrNav: numberOrNull(latest?.close ?? row.latestClose), change: numberOrNull(latest?.changePts ?? row.latestChange), changePercent: numberOrNull(latest?.changePct ?? row.latestChangePct), currency: row.currency, asOfDate: asOf?.toISOString() ?? null }, liteMetrics: [{ key: 'category', label: 'Category', value: row.category }] }, meta: meta(asOf, latest?.source ?? row.provider), error: null };
}

async function macroDetail(assetId: string) {
  const row = await prisma.economicSeries.findFirst({ where: { OR: [{ id: assetId }, { seriesId: assetId }, { code: assetId }] }, include: { values: { orderBy: { date: 'desc' }, take: 1 } } });
  if (!row) throw new Error('MACRO series not found.');
  const latest = row.values[0];
  return { data: { identity: { assetType: 'MACRO' as const, id: row.id, symbol: row.seriesId, name: row.name, displayName: row.name, currency: null, market: row.provider, country: row.country }, metrics: { priceOrNav: numberOrNull(latest?.value), change: null, changePercent: null, currency: row.unit, asOfDate: latest?.date.toISOString() ?? null }, liteMetrics: [{ key: 'unit', label: 'Unit', value: row.unit }, { key: 'frequency', label: 'Frequency', value: row.frequency }, { key: 'category', label: 'Category', value: row.category }] }, meta: meta(latest?.date ?? null, row.source, latest ? 'FULL' : 'UNKNOWN'), error: null };
}

async function fixedIncomeDetail(assetId: string) {
  const detail = await getGovernmentYieldDetail(assetId);
  if (!detail) throw new Error('Fixed-income yield series not found.');
  const identity = detail.identity as Record<string, unknown>;
  const latest = identity.latest as Record<string, unknown> | undefined;
  const freshness = identity.freshness as Record<string, unknown> | undefined;
  const asOf = latest?.observationDate ? new Date(String(latest.observationDate)) : null;
  const value = numberOrNull(latest?.value);
  return { data: { identity: { assetType: 'FIXED_INCOME' as const, id: String(identity.canonicalId), symbol: String(identity.canonicalId), name: String(identity.officialName), displayName: String(identity.officialName), currency: String(identity.currency), market: String(identity.authority), country: String(identity.jurisdiction) }, metrics: { priceOrNav: value, change: null, changePercent: null, currency: String(latest?.unit ?? identity.unit), asOfDate: asOf?.toISOString() ?? null }, liteMetrics: [{ key: 'instrumentType', label: 'Instrument', value: String(identity.curveType) }, { key: 'tenor', label: 'Tenor', value: String(identity.tenor) }, { key: 'frequency', label: 'Frequency', value: String(identity.frequency) }, { key: 'authority', label: 'Authority', value: String(identity.authority) }] }, meta: meta(asOf, String(latest?.source ?? identity.officialSource), freshness?.state === 'CURRENT' ? 'FULL' : 'PARTIAL_CURRENT'), error: null };
}

async function resolveDetail(assetId: string, assetType: AssetType, period: Period | null) {
  if (assetType === 'STOCK') return getStockDetail(assetId);
  if (assetType === 'ETF') return getEtfDetail(assetId);
  if (assetType === 'INDEX') return getIndexDetail(assetId);
  if (assetType === 'FX') return getFxDetail(assetId);
  if (assetType === 'MACRO') return macroDetail(assetId);
  if (assetType === 'FIXED_INCOME') return fixedIncomeDetail(assetId);
  if (assetType === 'COMMODITY' || assetType === 'CRYPTO') return marketDetail(assetId, assetType);
  const range: FundDetailRange = period ?? '1Y';
  const response = await getFundDetail(assetId, 0, range);
  const data = response.data!;
  const validHistory = data.history.data.filter((point): point is { date: string; nav: number } => point.nav !== null && Number.isFinite(point.nav));
  const latestNav = data.nav.data.value;
  const navDate = data.nav.data.date ? Date.parse(data.nav.data.date) : Number.POSITIVE_INFINITY;
  const previousNav = validHistory.filter((point) => Date.parse(point.date) < navDate).at(-1)?.nav ?? null;
  const change = latestNav !== null && previousNav !== null ? latestNav - previousNav : null;
  const changePercent = change !== null && previousNav !== null && previousNav !== 0 ? (change / previousNav) * 100 : null;
  return { data: { identity: data.identity, metrics: { priceOrNav: latestNav, change, changePercent, currency: data.nav.data.currency, asOfDate: data.nav.data.date }, liteMetrics: [{ key: 'company', label: 'Company', value: data.company }, { key: 'category', label: 'Category', value: data.category }, { key: 'fundCategory', label: 'Fund Category', value: data.fundCategory }, { key: 'fundSubcategory', label: 'Fund Subcategory', value: data.fundSubcategory }, { key: 'assetClass', label: 'Asset Class', value: data.assetClass }, { key: 'fee', label: 'Expense / Fee', value: data.feesTerms.data[0]?.ter ?? data.feesTerms.data[0]?.ongoingCharges ?? data.feesTerms.data[0]?.managementFee ?? null, unit: '%' }] }, meta: response.meta, error: response.error };
}

async function pagedHistory(assetType: Extract<AssetType, 'STOCK' | 'ETF' | 'INDEX' | 'FX'>, symbol: string, period: Period) {
  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  let response: HistoryResponse | null = null;
  for (let page = 0; page < 25; page += 1) {
    const query = { from: fromFor(period), cursor, pageSize: 200 };
    response = assetType === 'STOCK' ? await getStockHistory(symbol, query) : assetType === 'ETF' ? await getEtfHistory(symbol, query) : assetType === 'INDEX' ? await getIndexHistory(symbol, query) : await getFxHistory(symbol, query);
    rows.push(...((response.data ?? []) as Array<Record<string, unknown>>));
    cursor = response.pagination?.nextCursor ?? undefined;
    if (!cursor) break;
  }
  const value = (row: Record<string, unknown>) => assetType === 'STOCK' ? row.adjustedClose ?? row.close : assetType === 'ETF' ? row.adjustedClose ?? row.close ?? row.price ?? row.nav : row.close;
  return { points: sample(rows.map((row) => ({
    date: String(row.date ?? row.timestamp),
    value: Number(value(row)),
    ...(assetType === 'STOCK' ? {
      open: numberOrNull(row.open),
      high: numberOrNull(row.high),
      low: numberOrNull(row.low),
      close: numberOrNull(row.close),
      volume: numberOrNull(row.volume),
    } : assetType === 'ETF' ? { open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low), close: numberOrNull(row.close), adjustedClose: numberOrNull(row.adjustedClose) } : {}),
  })).filter((row) => Number.isFinite(row.value)).toReversed()), meta: response?.meta };
}

async function directHistory(assetId: string, assetType: 'MACRO' | 'COMMODITY' | 'CRYPTO' | 'FIXED_INCOME', period: Period) {
  const from = fromFor(period);
  if (assetType === 'FIXED_INCOME') {
    const detail = await getGovernmentYieldDetail(assetId);
    if (!detail) throw new Error('Fixed-income yield series not found.');
    const history = detail.history as { rows?: Array<Record<string, unknown>> };
    const rows = (history.rows ?? []).filter((row) => !from || new Date(String(row.observationDate)) >= from);
    const points = sample(rows.map((row) => ({ date: String(row.observationDate), value: Number(row.value) })).filter((row) => Number.isFinite(row.value)));
    const latestDate = points.at(-1)?.date ? new Date(points.at(-1)!.date) : null;
    return { points, meta: meta(latestDate, String((detail.identity as Record<string, unknown>).officialSource), points.length ? 'FULL' : 'UNKNOWN') };
  }
  if (assetType === 'MACRO') {
    const series = await prisma.economicSeries.findFirst({ where: { OR: [{ id: assetId }, { seriesId: assetId }, { code: assetId }] } });
    if (!series) throw new Error('MACRO series not found.');
    const rows = await prisma.economicValue.findMany({ where: { seriesId: series.id, value: { not: null }, ...(from ? { date: { gte: from } } : {}) }, orderBy: { date: 'asc' }, take: 5000 });
    return { points: sample(rows.map((row) => ({ date: row.date.toISOString(), value: Number(row.value) }))), meta: meta(rows.at(-1)?.date ?? null, series.source) };
  }
  const master = await prisma.marketMaster.findFirst({ where: { assetType, OR: [{ id: assetId }, { symbol: { equals: assetId, mode: 'insensitive' } }] } });
  if (!master) throw new Error(`${assetType} not found.`);
  const rows = await prisma.marketData.findMany({ where: { symbol: master.symbol, type: assetType, ...(from ? { date: { gte: from } } : {}) }, orderBy: { date: 'asc' }, take: 5000 });
  return { points: sample(rows.map((row) => ({ date: row.date.toISOString(), value: Number(row.close) }))), meta: meta(rows.at(-1)?.date ?? null, rows.at(-1)?.source ?? master.provider) };
}

export async function GET(request: Request, context: RouteContext<'/api/mobile/assets/[assetId]'>) {
  try {
    const { assetId } = await context.params;
    const params = new URL(request.url).searchParams;
    const requestedType = params.get('type')?.toUpperCase() as AssetType;
    if (!['STOCK', 'ETF', 'FUND', 'INDEX', 'FX', 'MACRO', 'COMMODITY', 'CRYPTO', 'FIXED_INCOME'].includes(requestedType)) throw new Error('Unsupported asset type.');
    const periodValue = params.get('period')?.toUpperCase();
    const period = periodValue && periodValue in PERIOD_DAYS ? periodValue as Period : null;
    const id = decodeURIComponent(assetId);
    const detail = await resolveDetail(id, requestedType, period);
    if (!period) return Response.json(detail, { headers: { ...corsHeaders, 'Cache-Control': 'private, max-age=30' } });
    if (requestedType === 'FUND') {
      const fund = await getFundDetail(id, 0, period);
      const points = fund.data!.history.data.map((row) => ({ date: row.date, value: Number(row.nav) })).filter((row) => Number.isFinite(row.value));
      return Response.json({ data: { period, points }, meta: fund.meta, error: null }, { headers: { ...corsHeaders, 'Cache-Control': 'private, max-age=30' } });
    }
    const symbol = detail.data!.identity.symbol;
    const history = requestedType === 'MACRO' || requestedType === 'COMMODITY' || requestedType === 'CRYPTO' || requestedType === 'FIXED_INCOME' ? await directHistory(id, requestedType, period) : await pagedHistory(requestedType, symbol, period);
    return Response.json({ data: { period, points: history.points }, meta: history.meta ?? detail.meta, error: null }, { headers: { ...corsHeaders, 'Cache-Control': 'private, max-age=30' } });
  } catch (error) {
    const result = errorResponse(error);
    return Response.json(result.body, { status: result.status, headers: corsHeaders });
  }
}
