import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.ts";
import { WebDataError } from "./errors.ts";
import { freshnessStatus } from "./freshness.ts";
import { normalizePagination, paginationMeta } from "./pagination.ts";
import { buildProvenance } from "./provenance.ts";
import { isoOrNull, numberOrNull, type CanonicalIdentity, type HistoryQuery, type ListQuery, type Provenance, type ResponseMeta, type ServiceResponse, type SummaryMetrics } from "./types.ts";
import { mapFundMainCategory, type FundMainCategory } from "./fundCategoryMapping.ts";

const fundIdentity = (row: { id: string; code: string | null; isin: string | null; name: string; currency: string; domicile: string | null; region: string | null }): CanonicalIdentity => ({ assetType: "FUND", id: row.id, symbol: row.code ?? row.isin ?? row.id, name: row.name, displayName: row.name, currency: row.currency, market: row.domicile, country: row.region ?? row.domicile });
const fundMetrics = (row: { latestNav: unknown; currency: string; latestNavDate: Date | null; return1y: unknown }): SummaryMetrics => ({ priceOrNav: numberOrNull(row.latestNav), change: null, changePercent: null, currency: row.currency, asOfDate: isoOrNull(row.latestNavDate), performance1M: null, performance3M: null, performance1Y: numberOrNull(row.return1y) });

export type FundListQuery = ListQuery & {
  company?: string;
  currency?: string;
  category?: string;
  riskLevel?: number;
  sort?: "name" | "latestNavDate" | "performance1Y";
  direction?: "asc" | "desc";
};

export interface FundListItem {
  identity: CanonicalIdentity;
  isin: string | null;
  metrics: SummaryMetrics;
  company: string;
  category: string | null;
  fundCategory: FundMainCategory;
  fundSubcategory: string | null;
  riskLevel: number | null;
  freshnessStatus: ReturnType<typeof freshnessStatus>;
  publicReady: boolean;
  source: string | null;
}

export async function getFundList(query: FundListQuery = {}): Promise<ServiceResponse<FundListItem[]>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const term = query.query?.trim();
  const direction: Prisma.SortOrder = query.direction === "desc" ? "desc" : "asc";
  const where = {
    isActive: true,
    ...(query.company ? { company: query.company } : {}),
    ...(query.currency ? { currency: query.currency } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.riskLevel ? { riskLevel: query.riskLevel } : {}),
    ...(term ? { OR: [{ code: { contains: term, mode: "insensitive" as const } }, { isin: { contains: term, mode: "insensitive" as const } }, { name: { contains: term, mode: "insensitive" as const } }, { company: { contains: term, mode: "insensitive" as const } }] } : {}),
  };
  const orderBy = query.sort === "latestNavDate"
    ? [{ latestNavDate: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
    : query.sort === "performance1Y"
      ? [{ return1y: { sort: direction, nulls: "last" as const } }, { id: "asc" as const }]
      : [{ name: direction }, { id: "asc" as const }];
  const [total, rows] = await prisma.$transaction([
    prisma.fund.count({ where }),
    prisma.fund.findMany({ where, skip, take: pageSize, orderBy }),
  ]);
  const readiness = rows.length ? await prisma.$queryRaw<Array<{id:string;history_ready:boolean}>>(Prisma.sql`SELECT f.id,EXISTS(SELECT 1 FROM fund_history h WHERE h.fund_id=f.id OFFSET 19 LIMIT 1) history_ready FROM funds f WHERE f.id IN (${Prisma.join(rows.map(row=>row.id))})`) : [];
  const readyByFund = new Map(readiness.map(row=>[row.id,row.history_ready]));
  const latest = rows.reduce<Date | null>((value, row) => !value || (row.latestNavDate && row.latestNavDate > value) ? row.latestNavDate : value, null);
  const updated = rows.reduce<Date | null>((value, row) => !value || row.updatedAt > value ? row.updatedAt : value, null);
  const source = rows.length === 1 ? rows[0].lastNavSource ?? rows[0].dataSource ?? rows[0].dataProvider : "MULTIPLE_VERIFIED_PROVIDERS";
  const provenance = buildProvenance({ source, asOfDate: latest, lastUpdated: updated });
  return { data: rows.map((row) => ({ identity: fundIdentity(row), isin: row.isin, metrics: fundMetrics(row), company: row.company, category: row.category, fundCategory: mapFundMainCategory(row.category), fundSubcategory: row.category, riskLevel: row.riskLevel, freshnessStatus: freshnessStatus(row.latestNavDate, "PUBLICATION_AWARE"), publicReady: row.latestNav != null && row.latestNavDate != null && readyByFund.get(row.id) === true && !["STALE","UNKNOWN","UNAVAILABLE"].includes(freshnessStatus(row.latestNavDate, "PUBLICATION_AWARE")), source: row.lastNavSource ?? row.dataSource ?? row.dataProvider })), meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(latest, "PUBLICATION_AWARE"), source, provenance, coverageStatus: "PARTIAL_CURRENT" }, pagination: paginationMeta(page, pageSize, total), error: null };
}

export async function getFundFilterOptions(): Promise<{ companies: string[]; currencies: string[]; categories: string[]; riskLevels: number[] }> {
  const [companies, currencies, categories, riskLevels] = await Promise.all([
    prisma.fund.findMany({ where: { isActive: true, company: { not: "" } }, distinct: ["company"], select: { company: true }, orderBy: { company: "asc" }, take: 100 }),
    prisma.fund.findMany({ where: { isActive: true }, distinct: ["currency"], select: { currency: true }, orderBy: { currency: "asc" }, take: 30 }),
    prisma.fund.findMany({ where: { isActive: true, category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" }, take: 100 }),
    prisma.fund.findMany({ where: { isActive: true, riskLevel: { not: null } }, distinct: ["riskLevel"], select: { riskLevel: true }, orderBy: { riskLevel: "asc" }, take: 10 }),
  ]);
  return {
    companies: companies.map((row) => row.company),
    currencies: currencies.map((row) => row.currency),
    categories: categories.flatMap((row) => row.category ? [row.category] : []),
    riskLevels: riskLevels.flatMap((row) => row.riskLevel === null ? [] : [row.riskLevel]),
  };
}

export const searchFunds = (query: string, options: Omit<ListQuery, "query"> = {}) => getFundList({ ...options, query });

export type FundDetailRange = "1M" | "3M" | "6M" | "1Y" | "3Y" | "5Y" | "10Y" | "MAX";
export type FundSectionCoverage = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" | "SOURCE_PENDING";
export const FUND_DETAIL_LIMITS = { history: 240, shareClasses: 20, riskMetrics: 20, classifications: 20, holdings: 20, documents: 20 } as const;

export interface FundSection<T> {
  coverage: FundSectionCoverage;
  data: T;
  provenance: Provenance;
}

export interface FundDetailData {
  identity: CanonicalIdentity & { isin: string | null; code: string | null };
  company: string | null;
  assetClass: string | null;
  category: string | null;
  fundCategory: FundMainCategory;
  fundSubcategory: string | null;
  riskRating: number | null;
  nav: FundSection<{ value: number | null; currency: string | null; date: string | null }>;
  history: FundSection<Array<{ date: string; nav: number | null }>> & { range: FundDetailRange; maxPoints: number };
  performance: FundSection<{ return1M: number | null; return3M: number | null; return6M: number | null; returnYtd: number | null; return1Y: number | null; return3YAnnualized: number | null; return5YAnnualized: number | null; semantics: "NAV_RETURN" }>;
  riskMetrics: FundSection<Array<{ metricCode: string; period: string; value: number; asOfDate: string; calculationMethod: string; observationCount: number; source: string; returnSemantics: string | null }>>;
  shareClasses: FundSection<Array<{ id: string; name: string; code: string | null; isin: string | null; currency: string | null; distributionType: string | null; accumulationDistribution: string | null; hedged: boolean | null; hedgedCurrency: string | null; investorType: string | null; source: string }>>;
  feesTerms: FundSection<Array<{ shareClass: string; managementFee: number | null; ongoingCharges: number | null; ter: number | null; salesChargeFront: number | null; salesChargeBack: number | null; performanceFee: number | null; minimumInitialInvestment: number | null; distributionFrequency: string | null; hedgingTerms: string | null; source: string | null; asOfDate: string | null }>>;
  classifications: FundSection<Array<{ type: string; name: string; value: string | null; method: string; benchmarkName: string | null; benchmarkCode: string | null; benchmarkId: string | null; source: string; asOfDate: string | null }>>;
  holdings: FundSection<{ reportDate: string | null; items: Array<{ holdingName: string | null; securityId: string | null; weight: number | null; marketValue: number | null; currency: string | null; source: string }> }>;
  documents: FundSection<Array<{ type: string; title: string | null; date: string | null; language: string | null; url: string; source: string }>>;
  flows: FundSection<null>;
}

type HoldingRow = { security_id: string | null; holding_name: string | null; weight: unknown; market_value: unknown; currency: string | null; report_date: Date; source: string; updated_at: Date };
type ShareClassRow = { id: string; shareClassName: string; shareClassCode: string | null; isin: string | null; currency: string | null; distributionType: string | null; distributionFrequency: string | null; accumulatingDistributing: string | null; hedgedCurrency: string | null; hedged: boolean | null; institutionalRetail: string | null; managementFee: unknown; ongoingCharges: unknown; ter: unknown; salesChargeFront: unknown; salesChargeBack: unknown; performanceFee: unknown; minimumInitialInvestment: unknown; termsSource: string | null; termsSourceRecordId: string | null; termsAsOfDate: Date | null; source: string; sourceRecordId: string | null; updatedAt: Date };
type DocumentRow = { id: string; documentType: string; documentTitle: string | null; documentDate: Date | null; effectiveDate: Date | null; language: string | null; url: string; source: string; sourceRecordId: string | null; updatedAt: Date };
type ClassificationRow = { id: string; classificationType: string; classificationName: string; classificationValue: string | null; classificationMethod: string; benchmarkName: string | null; benchmarkCode: string | null; benchmarkId: string | null; source: string; sourceRecordId: string | null; asOfDate: Date | null; updatedAt: Date };
type RiskMetricRow = { id: string; metricCode: string; period: string; value: unknown; asOfDate: Date; calculationMethod: string; observationCount: number; source: string; returnSemantics: string | null; updatedAt: Date };

const rangeStart = (range: FundDetailRange): Date | undefined => {
  if (range === "MAX") return undefined;
  const now = new Date();
  const months = range === "1M" ? 1 : range === "3M" ? 3 : range === "6M" ? 6 : range === "1Y" ? 12 : range === "3Y" ? 36 : range === "5Y" ? 60 : 120;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
};

const sectionCoverage = (count: number, partial = false): FundSectionCoverage => count === 0 ? "UNAVAILABLE" : partial ? "PARTIAL" : "AVAILABLE";

export async function getFundDetail(identifier: string, relationLimit = 20, range: FundDetailRange = "1Y"): Promise<ServiceResponse<FundDetailData>> {
  const key = decodeURIComponent(identifier).trim();
  if (!key) throw new WebDataError("INVALID_QUERY", "A fund identifier is required.");
  if (!Number.isInteger(relationLimit) || relationLimit < 0 || relationLimit > 20) throw new WebDataError("INVALID_PAGINATION", "Fund relation limit must be between 0 and 20.");
  if (!(["1M", "3M", "6M", "1Y", "3Y", "5Y", "10Y", "MAX"] as string[]).includes(range)) throw new WebDataError("INVALID_QUERY", "Unsupported fund history range.");
  const row = await prisma.fund.findFirst({ where: { OR: [{ id: key }, { code: { equals: key, mode: "insensitive" } }, { isin: { equals: key, mode: "insensitive" } }] } });
  if (!row) throw new WebDataError("NOT_FOUND", "Fund not found.");
  const sectionLimit = Math.min(relationLimit, 20);
  const from = rangeStart(range);
  const [historyRows, performance, shareClasses, documents, classifications, riskMetrics, holdings] = await Promise.all([
    prisma.fundHistory.findMany({ where: { fundId: row.id, ...(from ? { date: { gte: from } } : {}) }, orderBy: { date: "desc" }, take: 10_000, select: { date: true, nav: true, return1m: true, return3m: true, return6m: true, returnYtd: true, return1y: true, return3y: true, return5y: true, createdAt: true } }),
    prisma.fundPerformance.findFirst({ where: { fundId: row.id }, orderBy: { date: "desc" } }),
    sectionLimit ? prisma.$queryRaw<ShareClassRow[]>(Prisma.sql`SELECT id, share_class_name AS "shareClassName", share_class_code AS "shareClassCode", isin, currency, distribution_type AS "distributionType", distribution_frequency AS "distributionFrequency", accumulating_distributing AS "accumulatingDistributing", hedged_currency AS "hedgedCurrency", hedged, institutional_retail AS "institutionalRetail", management_fee AS "managementFee", ongoing_charges AS "ongoingCharges", ter, sales_charge_front AS "salesChargeFront", sales_charge_back AS "salesChargeBack", performance_fee AS "performanceFee", minimum_initial_investment AS "minimumInitialInvestment", terms_source AS "termsSource", terms_source_record_id AS "termsSourceRecordId", terms_as_of_date AS "termsAsOfDate", source, source_record_id AS "sourceRecordId", updated_at AS "updatedAt" FROM fund_share_classes WHERE fund_id = ${row.id} ORDER BY updated_at DESC LIMIT ${sectionLimit}`) : Promise.resolve([]),
    sectionLimit ? prisma.$queryRaw<DocumentRow[]>(Prisma.sql`SELECT id, document_type AS "documentType", document_title AS "documentTitle", document_date AS "documentDate", effective_date AS "effectiveDate", language, url, source, source_record_id AS "sourceRecordId", updated_at AS "updatedAt" FROM fund_documents WHERE fund_id = ${row.id} AND is_current IS TRUE AND url LIKE 'https://%' ORDER BY document_date DESC NULLS LAST, updated_at DESC LIMIT ${sectionLimit}`) : Promise.resolve([]),
    sectionLimit ? prisma.$queryRaw<ClassificationRow[]>(Prisma.sql`SELECT id, classification_type AS "classificationType", classification_name AS "classificationName", classification_value AS "classificationValue", classification_method AS "classificationMethod", benchmark_name AS "benchmarkName", benchmark_code AS "benchmarkCode", benchmark_id AS "benchmarkId", source, source_record_id AS "sourceRecordId", as_of_date AS "asOfDate", updated_at AS "updatedAt" FROM fund_classifications WHERE fund_id = ${row.id} ORDER BY as_of_date DESC NULLS LAST, updated_at DESC LIMIT ${sectionLimit}`) : Promise.resolve([]),
    sectionLimit ? prisma.$queryRaw<RiskMetricRow[]>(Prisma.sql`SELECT id, metric_code AS "metricCode", period, value, as_of_date AS "asOfDate", calculation_method AS "calculationMethod", observation_count AS "observationCount", source, return_semantics AS "returnSemantics", updated_at AS "updatedAt" FROM fund_risk_metrics WHERE fund_id = ${row.id} ORDER BY as_of_date DESC, updated_at DESC LIMIT ${sectionLimit}`) : Promise.resolve([]),
    sectionLimit ? prisma.$queryRaw<HoldingRow[]>(Prisma.sql`SELECT security_id, holding_name, weight, market_value, currency, report_date, source, updated_at FROM fund_holdings WHERE fund_id = ${row.id} AND report_date = (SELECT MAX(report_date) FROM fund_holdings WHERE fund_id = ${row.id}) ORDER BY weight DESC NULLS LAST, market_value DESC NULLS LAST LIMIT ${FUND_DETAIL_LIMITS.holdings}`) : Promise.resolve([]),
  ]);
  const source = row.lastNavSource ?? row.dataSource ?? row.dataProvider;
  const provenance = buildProvenance({ source, sourceRecordId: row.isin, asOfDate: row.latestNavDate, lastUpdated: row.updatedAt });
  const latestHistory = historyRows[0];
  const historyProvenance = buildProvenance({ source, sourceRecordId: row.id, asOfDate: latestHistory?.date, lastUpdated: latestHistory?.createdAt });
  const latestReturns = performance ?? latestHistory;
  const performanceDate = performance?.date ?? latestHistory?.date;
  const performanceProvenance = buildProvenance({ source, sourceRecordId: row.id, asOfDate: performanceDate, lastUpdated: performance?.createdAt ?? latestHistory?.createdAt });
  const riskLatest = riskMetrics[0];
  const holdingLatest = holdings[0];
  const documentLatest = documents[0];
  const classificationLatest = classifications[0];
  const shareLatest = shareClasses[0];
  const fees: FundDetailData["feesTerms"]["data"] = shareClasses.map((shareClass) => ({ shareClass: shareClass.shareClassName, managementFee: numberOrNull(shareClass.managementFee), ongoingCharges: numberOrNull(shareClass.ongoingCharges), ter: numberOrNull(shareClass.ter), salesChargeFront: numberOrNull(shareClass.salesChargeFront), salesChargeBack: numberOrNull(shareClass.salesChargeBack), performanceFee: numberOrNull(shareClass.performanceFee), minimumInitialInvestment: numberOrNull(shareClass.minimumInitialInvestment), distributionFrequency: shareClass.distributionFrequency ?? row.distributionFreq, hedgingTerms: shareClass.hedged === null ? null : shareClass.hedged ? shareClass.hedgedCurrency ? `HEDGED_${shareClass.hedgedCurrency}` : "HEDGED" : "UNHEDGED", source: shareClass.termsSource ?? shareClass.source, asOfDate: isoOrNull(shareClass.termsAsOfDate) }));
  if (!fees.length && (row.expenseRatio !== null || row.distributionFreq)) fees.push({ shareClass: row.name, managementFee: null, ongoingCharges: null, ter: numberOrNull(row.expenseRatio), salesChargeFront: null, salesChargeBack: null, performanceFee: null, minimumInitialInvestment: null, distributionFrequency: row.distributionFreq, hedgingTerms: null, source, asOfDate: isoOrNull(row.latestNavDate) });
  const classificationAssetClass = classifications.find((item) => /ASSET.CLASS/i.test(item.classificationType))?.classificationValue ?? classifications.find((item) => /ASSET.CLASS/i.test(item.classificationType))?.classificationName ?? null;
  const chronologicalHistory = historyRows.toReversed();
  const sampledHistory = chronologicalHistory.length <= FUND_DETAIL_LIMITS.history
    ? chronologicalHistory
    : Array.from({ length: FUND_DETAIL_LIMITS.history }, (_, index) => chronologicalHistory[Math.round(index * (chronologicalHistory.length - 1) / (FUND_DETAIL_LIMITS.history - 1))]);
  const data: FundDetailData = {
    identity: { ...fundIdentity(row), isin: row.isin, code: row.code }, company: row.company.trim() || null, assetClass: classificationAssetClass, category: row.category, fundCategory: mapFundMainCategory(row.category), fundSubcategory: row.category, riskRating: row.riskLevel,
    nav: { coverage: row.latestNav === null ? "UNAVAILABLE" : "AVAILABLE", data: { value: numberOrNull(row.latestNav), currency: row.currency, date: isoOrNull(row.latestNavDate) }, provenance },
    history: { coverage: sectionCoverage(historyRows.length, historyRows.length < 2), range, maxPoints: FUND_DETAIL_LIMITS.history, data: sampledHistory.map((item) => ({ date: item.date.toISOString(), nav: numberOrNull(item.nav) })), provenance: historyProvenance },
    performance: { coverage: latestReturns && [latestReturns.return1m, latestReturns.return3m, latestReturns.return6m, latestReturns.returnYtd, latestReturns.return1y, latestReturns.return3y, latestReturns.return5y].some((value) => value !== null) ? "AVAILABLE" : "UNAVAILABLE", data: { return1M: numberOrNull(latestReturns?.return1m), return3M: numberOrNull(latestReturns?.return3m), return6M: numberOrNull(latestReturns?.return6m), returnYtd: numberOrNull(latestReturns?.returnYtd), return1Y: numberOrNull(latestReturns?.return1y), return3YAnnualized: numberOrNull(latestReturns?.return3y), return5YAnnualized: numberOrNull(latestReturns?.return5y), semantics: "NAV_RETURN" }, provenance: performanceProvenance },
    riskMetrics: { coverage: sectionCoverage(riskMetrics.length), data: riskMetrics.map((item) => ({ metricCode: item.metricCode, period: item.period, value: Number(item.value), asOfDate: item.asOfDate.toISOString(), calculationMethod: item.calculationMethod, observationCount: item.observationCount, source: item.source, returnSemantics: item.returnSemantics })), provenance: buildProvenance({ source: riskLatest?.source, sourceRecordId: riskLatest?.id, asOfDate: riskLatest?.asOfDate, lastUpdated: riskLatest?.updatedAt }) },
    shareClasses: { coverage: sectionCoverage(shareClasses.length, shareClasses.length > 0), data: shareClasses.map((item) => ({ id: item.id, name: item.shareClassName, code: item.shareClassCode, isin: item.isin, currency: item.currency, distributionType: item.distributionType, accumulationDistribution: item.accumulatingDistributing, hedged: item.hedged, hedgedCurrency: item.hedgedCurrency, investorType: item.institutionalRetail, source: item.source })), provenance: buildProvenance({ source: shareLatest?.source, sourceRecordId: shareLatest?.sourceRecordId, asOfDate: shareLatest?.termsAsOfDate, lastUpdated: shareLatest?.updatedAt }) },
    feesTerms: { coverage: sectionCoverage(fees.length, fees.some((item) => Object.values(item).some((value) => value === null))), data: fees, provenance: buildProvenance({ source: shareLatest?.termsSource ?? shareLatest?.source ?? source, sourceRecordId: shareLatest?.termsSourceRecordId, asOfDate: shareLatest?.termsAsOfDate ?? row.latestNavDate, lastUpdated: shareLatest?.updatedAt ?? row.updatedAt }) },
    classifications: { coverage: sectionCoverage(classifications.length, classifications.length > 0), data: classifications.map((item) => ({ type: item.classificationType, name: item.classificationName, value: item.classificationValue, method: item.classificationMethod, benchmarkName: item.benchmarkName, benchmarkCode: item.benchmarkCode, benchmarkId: item.benchmarkId, source: item.source, asOfDate: isoOrNull(item.asOfDate) })), provenance: buildProvenance({ source: classificationLatest?.source, sourceRecordId: classificationLatest?.sourceRecordId, asOfDate: classificationLatest?.asOfDate, lastUpdated: classificationLatest?.updatedAt }) },
    holdings: { coverage: sectionCoverage(holdings.length), data: { reportDate: isoOrNull(holdingLatest?.report_date), items: holdings.map((item) => ({ holdingName: item.holding_name, securityId: item.security_id, weight: numberOrNull(item.weight), marketValue: numberOrNull(item.market_value), currency: item.currency, source: item.source })) }, provenance: buildProvenance({ source: holdingLatest?.source, sourceRecordId: row.id, asOfDate: holdingLatest?.report_date, lastUpdated: holdingLatest?.updated_at }) },
    documents: { coverage: sectionCoverage(documents.length, documents.length > 0), data: documents.map((item) => ({ type: item.documentType, title: item.documentTitle, date: isoOrNull(item.documentDate ?? item.effectiveDate), language: item.language, url: item.url, source: item.source })), provenance: buildProvenance({ source: documentLatest?.source, sourceRecordId: documentLatest?.sourceRecordId, asOfDate: documentLatest?.documentDate ?? documentLatest?.effectiveDate, lastUpdated: documentLatest?.updatedAt }) },
    flows: { coverage: "SOURCE_PENDING", data: null, provenance: buildProvenance({}) },
  };
  if (data.company && /^(待補|unknown|n\/a)/i.test(data.company)) data.company = null;
  const meta: ResponseMeta = { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(row.latestNavDate, "PUBLICATION_AWARE"), source, provenance, coverageStatus: "PARTIAL_CURRENT" };
  return { data, meta, pagination: null, error: null };
}

export async function getFundHistory(identifier: string, query: HistoryQuery = {}): Promise<ServiceResponse<Array<{ date: string; nav: number | null; aum: number | null; return1M: number | null; return3M: number | null; return1Y: number | null }>>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const fund = await prisma.fund.findFirst({ where: { OR: [{ id: identifier }, { code: { equals: identifier, mode: "insensitive" } }, { isin: { equals: identifier, mode: "insensitive" } }] }, select: { id: true, lastNavSource: true, dataSource: true, dataProvider: true } });
  if (!fund) throw new WebDataError("NOT_FOUND", "Fund not found.");
  const cursorDate = query.cursor ? new Date(query.cursor) : null;
  if (cursorDate && Number.isNaN(cursorDate.getTime())) throw new WebDataError("INVALID_QUERY", "Invalid history cursor.");
  const where = { fundId: fund.id, date: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}), ...(cursorDate ? { lt: cursorDate } : {}) } };
  const [total, rows] = await prisma.$transaction([prisma.fundHistory.count({ where }), prisma.fundHistory.findMany({ where, skip: cursorDate ? 0 : skip, take: pageSize, orderBy: { date: "desc" } })]);
  const source = fund.lastNavSource ?? fund.dataSource ?? fund.dataProvider;
  const provenance = buildProvenance({ source, asOfDate: rows[0]?.date, lastUpdated: rows[0]?.createdAt });
  return { data: rows.map((row) => ({ date: row.date.toISOString(), nav: numberOrNull(row.nav), aum: numberOrNull(row.aum), return1M: numberOrNull(row.return1m), return3M: numberOrNull(row.return3m), return1Y: numberOrNull(row.return1y) })), meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(rows[0]?.date, "PUBLICATION_AWARE"), source, provenance, coverageStatus: "PARTIAL_CURRENT" }, pagination: paginationMeta(page, pageSize, total, rows.length === pageSize ? rows.at(-1)?.date.toISOString() ?? null : null), error: null };
}


