import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.ts";
import { WebDataError } from "./errors.ts";
import { freshnessStatus } from "./freshness.ts";
import { normalizePagination, paginationMeta } from "./pagination.ts";
import { buildProvenance } from "./provenance.ts";
import { isoOrNull, numberOrNull, type CanonicalIdentity, type HistoryQuery, type ListQuery, type ServiceResponse, type SummaryMetrics } from "./types.ts";
import { getCoreUniverseEtfIds } from "../../tw-purchasable/coreUniverseFilter.ts";

const etfIdentity = (row: { id: string; code: string; name: string; currency: string; exchange: string | null; region: string | null }): CanonicalIdentity => ({ assetType: "ETF", id: row.id, symbol: row.code, name: row.name, displayName: row.name, currency: row.currency, market: row.exchange, country: row.region });
const etfMetrics = (row: { latestPrice: unknown; latestNav: unknown; currency: string; priceUpdatedAt: Date | null; return1m: unknown; return3m: unknown; return1y: unknown; dividendYield: unknown }): SummaryMetrics => ({ priceOrNav: numberOrNull(row.latestPrice ?? row.latestNav), change: null, changePercent: null, currency: row.currency, asOfDate: isoOrNull(row.priceUpdatedAt), performance1M: numberOrNull(row.return1m), performance3M: numberOrNull(row.return3m), performance1Y: numberOrNull(row.return1y), dividendYield: numberOrNull(row.dividendYield) });

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

// 2026-10-13 QA-round-1 dedup fix: 92 TW ETFs exist as TWO rows -- a bare code ("006208") and a
// Yahoo-suffixed code ("006208.TW"/".TWO") for the same real-world ETF, from two independent
// ingestion pipelines. Per the user's decision, the bare-code row (market-close-sync's own, the
// "official" one) is kept and the suffixed duplicate is hidden from listings/search -- DISPLAY LAYER
// ONLY, no rows are deleted (that's a separate DDL-approval-gated cleanup, see
// docs/specs/etf-dedup-cleanup-draft.sql). 00981D's bare row was previously missing the
// dividend_yield its suffixed twin had -- docs/specs/00981D-dividend-yield-fix-draft.sql has since
// been executed (VERIFIED 2026-10-16: both rows show dividend_yield=0.0734), so there is no longer a
// gap to protect and this set is empty. Left as a named constant (not deleted outright) so the next
// person who finds a similar backfill-pending case has an obvious place to add it back.
const DEDUP_BACKFILL_PENDING = new Set<string>([]);

// 2026-10-14 round-4: was a manually-maintained 6-code list (020000/020012/020028/020030/020031/
// 020034.TW), found incomplete when the user spotted 020001.TWO ("Fubon Securities Co Ltd") was
// missing from it. Replaced with a RULE per the user's explicit instruction, instead of adding
// entries one at a time forever: a TW-listed (.TW/.TWO) row whose name is a securities BROKERAGE
// FIRM's own corporate name, not a fund product, is never a real ETF.
//
// Tried and rejected: (1) a bare code-prefix rule ("020xxx") -- TOO BROAD, it also matches 020032.TW,
// a genuine ETF ("Yuanta Taiwan Green Energy..."), and would have matched dozens of real Korean ETFs
// if not scoped to .TW/.TWO. (2) Yahoo's own `instrumentType` field -- checked live, Yahoo itself
// mislabels every one of these codes as "ETF", so it's not a usable signal here. (3) A bare
// "name contains Securities/證券" match -- TOO BROAD on its own: nearly every genuine TW ETF's own
// official long name contains "證券投資信託基金" (standard regulatory naming), and some genuine
// international ETFs/ETPs use "Securities" as part of a legitimate product name.
//
// What actually works: scope to .TW/.TWO AND require the name to contain Securities/證券 AND NOT
// contain any fund/ETF/index-indicating word. Verified live (2026-10-14) against the full `etfs`
// table: this matches exactly 17 rows, all of them real Taiwanese brokerage firms' own stock
// listings (Fubon/Yuanta/President/Uni-President/Yuanda/Mega Securities), and zero genuine ETFs --
// see docs/specs/misclassified-etf-codes.md for the full list this rule currently catches.
const MISCLASSIFIED_SECURITIES_FIRM_FILTER = Prisma.sql`
  code ~ '\.(TW|TWO)$'
  AND (name ILIKE '%securities%' OR name LIKE '%證券%')
  AND name !~* 'etf|fund|trust|index'
  AND name !~ '基金|信託|指數'
`;

async function getMisclassifiedSecuritiesFirmCodes(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ code: string }>>`SELECT code FROM etfs WHERE ${MISCLASSIFIED_SECURITIES_FIRM_FILTER}`;
  return rows.map((r) => r.code);
}

async function getSuffixedDuplicateCodesToHide(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ code: string }>>(`
    SELECT suffixed.code FROM etfs suffixed
    WHERE suffixed.code ~ '\\.(TW|TWO)$'
      AND EXISTS (SELECT 1 FROM etfs bare WHERE bare.code = regexp_replace(suffixed.code, '\\.(TW|TWO)$', ''))
  `);
  return rows.map((r) => r.code).filter((code) => !DEDUP_BACKFILL_PENDING.has(code.replace(/\.(TW|TWO)$/, "")));
}

export async function getEtfList(query: EtfListQuery = {}): Promise<ServiceResponse<EtfListItem[]>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const term = query.query?.trim();
  const direction: Prisma.SortOrder = query.direction === "desc" ? "desc" : "asc";
  const hiddenDuplicateCodes = [...(await getSuffixedDuplicateCodesToHide()), ...(await getMisclassifiedSecuritiesFirmCodes())];
  // 2026-10-19（使用者商品範圍規則，最高層）: 只顯示「台灣買得到」的核心母體 ETF。
  const coreIds = await getCoreUniverseEtfIds();
  const where = {
    isActive: true,
    id: { in: Array.from(coreIds) },
    ...(hiddenDuplicateCodes.length ? { code: { notIn: hiddenDuplicateCodes } } : {}),
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
  // 2026-10-24（使用者規則，第一條）: 詳情頁是「使用者挑選商品」這一層，不是持股穿透揭露，
  // 必須套用核心母體過濾——直接用 id/code/isin 查表原本會讓任何不在核心母體的 ETF（例如
  // LSE/Tokyo/HKSE 上市的，表裡仍有大量歷史遺留資料）只要猜得到網址就看得到詳情頁。
  const coreIds = await getCoreUniverseEtfIds();
  if (!coreIds.has(row.id)) throw new WebDataError("NOT_FOUND", "ETF not found.");
  const latest = row.history[0];
  const previous = row.history[1];
  const latestValue = numberOrNull(latest?.price ?? latest?.nav ?? row.latestPrice ?? row.latestNav);
  const previousValue = numberOrNull(previous?.price ?? previous?.nav);
  // 2026-10-13 QA-round-1 fix: prefer the authoritative day-change already written by
  // app/api/cron/cloud-etf-price/route.ts (Yahoo's own previousClose/regularMarketPrice — see that
  // route's comment) over deriving one from our own two-row EtfHistory diff, which can disagree with
  // Yahoo's own basis around non-trading-day gaps. Falls back to the diff only when that figure is
  // not yet available for this ETF.
  const latestPerformance = await prisma.etfPerformance.findFirst({ where: { etfId: row.id }, orderBy: { date: "desc" }, select: { return1d: true } });
  const authoritativeChangePercent = numberOrNull(latestPerformance?.return1d);
  const changePercent = authoritativeChangePercent ?? (previousValue != null && previousValue !== 0 && latestValue != null ? ((latestValue - previousValue) / previousValue) * 100 : null);
  // Absolute change derived from the authoritative percent (previousImplied = latest / (1 + pct/100)),
  // not a second independently-sourced number — this is unit conversion of the one authoritative value.
  const change = changePercent != null && latestValue != null
    ? (authoritativeChangePercent != null ? latestValue - latestValue / (1 + changePercent / 100) : latestValue - (previousValue as number))
    : null;
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


