import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.ts";
import { WebDataError } from "./errors.ts";
import { freshnessStatus } from "./freshness.ts";
import { normalizePagination, paginationMeta } from "./pagination.ts";
import { buildProvenance } from "./provenance.ts";
import { isoOrNull, numberOrNull, type CanonicalIdentity, type HistoryQuery, type ListQuery, type ServiceResponse, type SummaryMetrics } from "./types.ts";

const etfIdentity = (row: { id: string; code: string; name: string; currency: string; exchange: string | null; region: string | null }): CanonicalIdentity => ({ assetType: "ETF", id: row.id, symbol: row.code, name: row.name, displayName: row.name, currency: row.currency, market: row.exchange, country: row.region });
const etfMetrics = (row: { latestPrice: unknown; latestNav: unknown; currency: string; priceUpdatedAt: Date | null; return1m: unknown; return3m: unknown; return1y: unknown }): SummaryMetrics => ({ priceOrNav: numberOrNull(row.latestPrice ?? row.latestNav), change: null, changePercent: null, currency: row.currency, asOfDate: isoOrNull(row.priceUpdatedAt), performance1M: numberOrNull(row.return1m), performance3M: numberOrNull(row.return3m), performance1Y: numberOrNull(row.return1y) });

export type EtfListQuery = ListQuery & {
  exchange?: string;
  currency?: string;
  issuer?: string;
  category?: string;
  sort?: "name" | "latestPrice" | "aum" | "performance1Y";
  direction?: "asc" | "desc";
};

export interface EtfListItem {
  identity: CanonicalIdentity;
  issuer: string | null;
  category: string | null;
  price: number | null;
  nav: number | null;
  aum: number | null;
  sharesOutstanding: number | null;
  premiumDiscount: number | null;
  holdingsCount: number;
  flowCoverage: { status: "PARTIAL_CURRENT" | "UNAVAILABLE"; asOfDate: string | null };
  metrics: SummaryMetrics;
  freshnessStatus: ReturnType<typeof freshnessStatus>;
  source: string | null;
  publicReady: boolean;
}

type AssetMetricRow = { etf_id: string; observation_date: Date; aum: unknown; shares_outstanding: unknown; nav: unknown; source: string };
type FlowCoverageRow = { etf_id: string; observation_date: Date };
type ReadyRow = { id: string; latest_date: Date | null; history_ready: boolean };

export async function getEtfList(query: EtfListQuery = {}): Promise<ServiceResponse<EtfListItem[]>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const term = query.query?.trim();
  const direction: Prisma.SortOrder = query.direction === "desc" ? "desc" : "asc";
  const where = {
    isActive: true,
    ...(query.exchange ? { exchange: query.exchange } : {}),
    ...(query.currency ? { currency: query.currency } : {}),
    ...(query.issuer ? { provider: query.issuer } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(term ? { OR: [{ code: { contains: term, mode: "insensitive" as const } }, { name: { contains: term, mode: "insensitive" as const } }, { isin: { contains: term, mode: "insensitive" as const } }] } : {}),
  };
  const orderBy = query.sort === "latestPrice"
    ? [{ latestPrice: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
    : query.sort === "aum"
      ? [{ aum: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
      : query.sort === "performance1Y"
        ? [{ return1y: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
        : [{ name: direction }, { id: "asc" as const }];
  const [total, exactRows, rows] = await Promise.all([
    prisma.etf.count({ where }),
    term ? prisma.etf.findMany({ where: { isActive: true, code: { equals: term, mode: "insensitive" } }, take: 1, include: { _count: { select: { holdings: true } } } }) : Promise.resolve([]),
    prisma.etf.findMany({ where: term ? { ...where, NOT: { code: { equals: term, mode: "insensitive" } } } : where, skip: term ? 0 : skip, take: pageSize, orderBy, include: { _count: { select: { holdings: true } } } }),
  ]);
  const rowsWithExact = term ? [...exactRows, ...rows.filter((row) => !exactRows.some((exact) => exact.id === row.id))].slice(0, pageSize) : rows;
  const ids = rowsWithExact.map((row) => row.id);
  const [assetMetrics, flowCoverage, readiness] = ids.length ? await Promise.all([
    prisma.$queryRaw<AssetMetricRow[]>(Prisma.sql`SELECT DISTINCT ON (etf_id) etf_id, observation_date, aum, shares_outstanding, nav, source FROM etf_asset_metrics WHERE etf_id IN (${Prisma.join(ids)}) ORDER BY etf_id, observation_date DESC, updated_at DESC LIMIT ${pageSize}`),
    prisma.$queryRaw<FlowCoverageRow[]>(Prisma.sql`SELECT etf_id, MAX(observation_date) AS observation_date FROM etf_flows WHERE etf_id IN (${Prisma.join(ids)}) GROUP BY etf_id LIMIT ${pageSize}`),
    prisma.$queryRaw<ReadyRow[]>(Prisma.sql`SELECT e.id,(SELECT h.date FROM etf_history h WHERE h.etf_id=e.id ORDER BY h.date DESC LIMIT 1) latest_date,EXISTS(SELECT 1 FROM etf_history h WHERE h.etf_id=e.id OFFSET 19 LIMIT 1) history_ready FROM etfs e WHERE e.id IN (${Prisma.join(ids)})`),
  ]) : [[], [], []];
  const metricByEtf = new Map(assetMetrics.map((row) => [row.etf_id, row]));
  const flowByEtf = new Map(flowCoverage.map((row) => [row.etf_id, row]));
  const readyByEtf = new Map(readiness.map((row) => [row.id, row]));
  const latest = rows.reduce<Date | null>((value, row) => !value || (row.priceUpdatedAt && row.priceUpdatedAt > value) ? row.priceUpdatedAt : value, null);
  const updated = rows.reduce<Date | null>((value, row) => !value || row.updatedAt > value ? row.updatedAt : value, null);
  const sources = [...new Set(rows.map((row) => row.dataSource ?? row.dataProvider ?? row.provider).filter(Boolean))];
  const source = sources.length === 1 ? sources[0]! : sources.length ? "MULTIPLE_CANONICAL_SOURCES" : null;
  const provenance = buildProvenance({ source, asOfDate: latest, lastUpdated: updated });
  return { data: rowsWithExact.map((row) => {
    const assetMetric = metricByEtf.get(row.id);
    const flow = flowByEtf.get(row.id);
    const ready = readyByEtf.get(row.id);
    return { identity: etfIdentity(row), issuer: row.provider || null, category: row.category, price: numberOrNull(row.latestPrice), metrics: etfMetrics(row), nav: numberOrNull(assetMetric?.nav ?? row.latestNav), aum: numberOrNull(assetMetric?.aum ?? row.aum), sharesOutstanding: numberOrNull(assetMetric?.shares_outstanding), premiumDiscount: numberOrNull(row.premium), holdingsCount: row._count.holdings, flowCoverage: { status: flow ? "PARTIAL_CURRENT" : "UNAVAILABLE", asOfDate: isoOrNull(flow?.observation_date) }, freshnessStatus: freshnessStatus(ready?.latest_date, "MARKET_DAY"), publicReady: (row.latestPrice != null || row.latestNav != null) && ready?.history_ready === true && freshnessStatus(ready.latest_date, "MARKET_DAY") === "CURRENT", source: row.dataSource ?? row.dataProvider ?? row.provider };
  }), meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(latest, "MARKET_DAY"), source, provenance, coverageStatus: "PARTIAL_CURRENT" }, pagination: paginationMeta(page, pageSize, total), error: null };
}

export async function getEtfFilterOptions(): Promise<{ exchanges: string[]; currencies: string[]; issuers: string[]; categories: string[] }> {
  const [exchanges, currencies, issuers, categories] = await Promise.all([
    prisma.etf.findMany({ where: { isActive: true, exchange: { not: null } }, distinct: ["exchange"], select: { exchange: true }, orderBy: { exchange: "asc" }, take: 100 }),
    prisma.etf.findMany({ where: { isActive: true }, distinct: ["currency"], select: { currency: true }, orderBy: { currency: "asc" }, take: 30 }),
    prisma.etf.findMany({ where: { isActive: true, provider: { not: "" } }, distinct: ["provider"], select: { provider: true }, orderBy: { provider: "asc" }, take: 100 }),
    prisma.etf.findMany({ where: { isActive: true, category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" }, take: 100 }),
  ]);
  return { exchanges: exchanges.flatMap((row) => row.exchange ? [row.exchange] : []), currencies: currencies.map((row) => row.currency), issuers: issuers.map((row) => row.provider), categories: categories.flatMap((row) => row.category ? [row.category] : []) };
}

export async function searchEtfs(query: string, options: Omit<ListQuery, "query"> = {}) {
  return getEtfList({ ...options, query });
}

export async function getEtfDetail(code: string): Promise<ServiceResponse<{ identity: CanonicalIdentity; metrics: SummaryMetrics; nav: number | null; aum: number | null; premiumDiscount: number | null; expenseRatio: number | null; holdingsCount: number; holdingsAsOfDate: string | null; topHoldings: Array<{ name: string; symbol: string | null; weight: number | null }>; assetAllocation: Array<{ label: string; weight: number }>; sectorAllocation: Array<{ label: string; weight: number }>; category: string | null }>> {
  const key = decodeURIComponent(code).trim();
  if (!key) throw new WebDataError("INVALID_QUERY", "An ETF code is required.");
  const row = await prisma.etf.findFirst({ where: { OR: [{ id: key }, { code: { equals: key, mode: "insensitive" } }, { isin: { equals: key, mode: "insensitive" } }] }, include: { history: { where: { OR: [{ price: { not: null } }, { nav: { not: null } }] }, orderBy: { date: "desc" }, take: 2 } } });
  if (!row) throw new WebDataError("NOT_FOUND", "ETF not found.");
  const latest = row.history[0];
  const previous = row.history[1];
  const latestValue = numberOrNull(latest?.price ?? latest?.nav ?? row.latestPrice ?? row.latestNav);
  const previousValue = numberOrNull(previous?.price ?? previous?.nav);
  const change = latestValue != null && previousValue != null ? latestValue - previousValue : null;
  const changePercent = change != null && previousValue != null && previousValue !== 0 ? (change / previousValue) * 100 : null;
  const latestHolding = await prisma.holding.findFirst({ where: { etfId: row.id }, orderBy: [{ asOfDate: "desc" }, { rank: "asc" }], select: { asOfDate: true } });
  const holdings = latestHolding ? await prisma.holding.findMany({ where: { etfId: row.id, asOfDate: latestHolding.asOfDate }, orderBy: { rank: "asc" }, select: { holdingName: true, ticker: true, weight: true, sector: true, assetType: true } }) : [];
  const allocation = <T extends string>(keyFor: (holding: typeof holdings[number]) => T | null) => [...holdings.reduce((values, holding) => { const label = keyFor(holding); const weight = numberOrNull(holding.weight); if (label && weight != null) values.set(label, (values.get(label) ?? 0) + weight); return values; }, new Map<T, number>())].map(([label, weight]) => ({ label, weight })).sort((left, right) => right.weight - left.weight);
  const asOf = latest?.date ?? row.priceUpdatedAt;
  const source = row.dataSource ?? row.dataProvider ?? row.provider;
  const provenance = buildProvenance({ source, sourceRecordId: row.isin, asOfDate: asOf, lastUpdated: row.updatedAt });
  return { data: { identity: etfIdentity(row), metrics: { ...etfMetrics(row), priceOrNav: latestValue, change, changePercent, asOfDate: isoOrNull(asOf) }, nav: numberOrNull(latest?.nav ?? row.latestNav), aum: numberOrNull(latest?.aum ?? row.aum), premiumDiscount: numberOrNull(latest?.premium ?? row.premium), expenseRatio: numberOrNull(row.expenseRatio), holdingsCount: holdings.length, holdingsAsOfDate: isoOrNull(latestHolding?.asOfDate), topHoldings: holdings.slice(0, 10).map((holding) => ({ name: holding.holdingName, symbol: holding.ticker, weight: numberOrNull(holding.weight) })), assetAllocation: allocation((holding) => holding.assetType), sectorAllocation: allocation((holding) => holding.sector), category: row.category }, meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(asOf, "MARKET_DAY"), source, provenance, coverageStatus: "FULL" }, pagination: null, error: null };
}

export async function getEtfHistory(code: string, query: HistoryQuery = {}): Promise<ServiceResponse<Array<{ date: string; price: number | null; nav: number | null; premiumDiscount: number | null; volume: number | null; aum: number | null; open: number | null; high: number | null; low: number | null; close: number | null; adjustedClose: number | null }>>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const etf = await prisma.etf.findFirst({ where: { OR: [{ code: { equals: code, mode: "insensitive" } }, { isin: { equals: code, mode: "insensitive" } }] }, select: { id: true, dataSource: true, dataProvider: true, provider: true } });
  if (!etf) throw new WebDataError("NOT_FOUND", "ETF not found.");
  const cursorDate = query.cursor ? new Date(query.cursor) : null;
  if (cursorDate && Number.isNaN(cursorDate.getTime())) throw new WebDataError("INVALID_QUERY", "Invalid history cursor.");
  const where = { etfId: etf.id, date: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}), ...(cursorDate ? { lt: cursorDate } : {}) } };
  const [total, rows] = await Promise.all([prisma.etfHistory.count({ where }), prisma.etfHistory.findMany({ where, skip: cursorDate ? 0 : skip, take: pageSize, orderBy: { date: "desc" } })]);
  const source = etf.dataSource ?? etf.dataProvider ?? etf.provider;
  const provenance = buildProvenance({ source, asOfDate: rows[0]?.date, lastUpdated: rows[0]?.createdAt });
  return { data: rows.map((row) => ({ date: row.date.toISOString(), price: numberOrNull(row.price), nav: numberOrNull(row.nav), premiumDiscount: numberOrNull(row.premium), volume: numberOrNull(row.volume), aum: numberOrNull(row.aum), open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low), close: numberOrNull(row.close ?? row.price), adjustedClose: numberOrNull(row.adjustedClose ?? row.close ?? row.price) })), meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(rows[0]?.date, "MARKET_DAY"), source, provenance, coverageStatus: "FULL" }, pagination: paginationMeta(page, pageSize, total, rows.length === pageSize ? rows.at(-1)?.date.toISOString() ?? null : null), error: null };
}


