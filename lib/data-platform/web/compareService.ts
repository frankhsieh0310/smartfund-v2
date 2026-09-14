import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.ts";
import {
  ALIGNMENT_POLICIES,
  COMPARE_ASSET_TYPES,
  COMPARE_PERIODS,
  NORMALIZATION_POLICIES,
  correlation,
  normalizeObservations,
  requestHash,
  resolveWindow,
  seriesMetrics,
  type AlignmentPolicy,
  type CompareAssetType,
  type CompareContract,
  type ComparePeriod,
  type CompareRequestItem,
  type NormalizationPolicy,
  type Observation,
} from "../compare/core.ts";
import { WebDataError } from "./errors.ts";

export { COMPARE_ASSET_TYPES };
export type { CompareAssetType, CompareContract, CompareRequestItem };
export const MIN_COMPARE_ITEMS = 2;
export const MAX_COMPARE_ITEMS = 10;
export const COMPARE_CALCULATION_VERSION = "compare-p0-v1.0.0";

type LoadedItem = {
  request: CompareRequestItem;
  identity: { assetType: CompareAssetType; canonicalEntityId: string; symbolOrCode: string; name: string; currency: string | null; market: string | null };
  currentValue: number | null;
  currentValueSemantic: "PRICE" | "NAV" | "INDEX_LEVEL" | "FX_RATE" | "CRYPTO_PRICE";
  returnSemantic: "PRICE_RETURN" | "NAV_RETURN" | "INDEX_RETURN" | "FX_RETURN" | "CRYPTO_PRICE_RETURN";
  observations: Observation[];
  effectiveAsOfDate: string | null;
  lastCanonicalUpdatedAt: string | null;
  frequency: "DAILY" | "AVAILABLE_DATES";
  source: string | null;
  structural: Record<string, unknown>;
};

type IndexIdentityRow = { id: string; symbol: string; name: string; currency: string | null; exchange: string | null; updated_at: Date };
type IndexPointRow = { timestamp: Date; close: unknown; source: string; source_record_id: string | null; ingested_at: Date };
type CryptoIdentityRow = { id: string; name: string; symbol: string; market_id: string; quote_symbol: string | null; exchange_id: string; updated_at: Date };
type CryptoPointRow = { open_time: Date; close: unknown; source: string; source_record_id: string | null; updated_at: Date };

const asIso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const asNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);
const point = (date: Date, value: unknown, source: string | null, sourceRecordId?: string | null, updatedAt?: Date | null): Observation | null => {
  const numeric = asNumber(value);
  return numeric !== null && Number.isFinite(numeric) && numeric > 0 ? { date: date.toISOString(), value: numeric, source, sourceRecordId, updatedAt: asIso(updatedAt) } : null;
};

function validateContract(contract: CompareContract): void {
  if (contract.items.length < MIN_COMPARE_ITEMS || contract.items.length > MAX_COMPARE_ITEMS) throw new WebDataError("INVALID_QUERY", `Compare requires ${MIN_COMPARE_ITEMS} to ${MAX_COMPARE_ITEMS} items.`);
  if (!COMPARE_PERIODS.includes(contract.period)) throw new WebDataError("INVALID_QUERY", "Unsupported compare period.");
  if (!ALIGNMENT_POLICIES.includes(contract.alignmentPolicy)) throw new WebDataError("INVALID_QUERY", "Unsupported alignment policy.");
  if (!NORMALIZATION_POLICIES.includes(contract.normalizationPolicy)) throw new WebDataError("INVALID_QUERY", "Unsupported normalization policy.");
  const unique = new Set(contract.items.map((item) => `${item.assetType}:${item.canonicalEntityId}`));
  if (unique.size !== contract.items.length || contract.items.some((item) => !COMPARE_ASSET_TYPES.includes(item.assetType) || !item.canonicalEntityId.trim())) throw new WebDataError("INVALID_QUERY", "Invalid or duplicate compare item.");
  if (contract.normalizationPolicy === "FX_NORMALIZED" && !contract.baseCurrency) throw new WebDataError("INVALID_QUERY", "FX_NORMALIZED requires baseCurrency.");
}

async function loadStock(item: CompareRequestItem, start: Date | undefined, end: Date): Promise<LoadedItem> {
  const row = await prisma.stock.findFirst({ where: { id: item.canonicalEntityId }, include: { history: { where: { date: { ...(start ? { gte: start } : {}), lte: end } }, orderBy: { date: "asc" }, take: 5000 }, financialFacts: { orderBy: { periodEnd: "desc" }, take: 100 } } });
  if (!row) throw new WebDataError("NOT_FOUND", "Canonical stock not found.");
  const observations = row.history.flatMap((entry) => { const value = point(entry.date, entry.adjustedClose ?? entry.close, entry.source, entry.sourceSymbol, entry.updatedAt ?? entry.importedAt); return value ? [value] : []; });
  const facts = new Map<string, number>();
  for (const fact of row.financialFacts) if (!facts.has(fact.metric)) facts.set(fact.metric, Number(fact.value));
  return { request: item, identity: { assetType: "STOCK", canonicalEntityId: row.id, symbolOrCode: row.yahooSymbol, name: row.companyName, currency: row.currency, market: row.exchange }, currentValue: asNumber(row.latestClose), currentValueSemantic: "PRICE", returnSemantic: "PRICE_RETURN", observations, effectiveAsOfDate: asIso(row.latestDate), lastCanonicalUpdatedAt: asIso(row.updatedAt), frequency: "DAILY", source: observations.at(-1)?.source ?? null, structural: { sector: row.sector, industry: row.industry, fundamentals: Object.fromEntries(facts) } };
}

async function loadEtf(item: CompareRequestItem, start: Date | undefined, end: Date): Promise<LoadedItem> {
  const row = await prisma.etf.findFirst({ where: { id: item.canonicalEntityId }, include: { history: { where: { date: { ...(start ? { gte: start } : {}), lte: end } }, orderBy: { date: "asc" }, take: 5000 }, holdings: { orderBy: [{ asOfDate: "desc" }, { rank: "asc" }], take: 100 } } });
  if (!row) throw new WebDataError("NOT_FOUND", "Canonical ETF not found.");
  const observations = row.history.flatMap((entry) => { const value = point(entry.date, entry.price ?? entry.nav, row.dataSource ?? row.dataProvider ?? row.provider, row.isin, entry.createdAt); return value ? [value] : []; });
  return { request: item, identity: { assetType: "ETF", canonicalEntityId: row.id, symbolOrCode: row.code, name: row.name, currency: row.currency, market: row.exchange }, currentValue: asNumber(row.latestPrice ?? row.latestNav), currentValueSemantic: "PRICE", returnSemantic: "PRICE_RETURN", observations, effectiveAsOfDate: asIso(row.priceUpdatedAt), lastCanonicalUpdatedAt: asIso(row.updatedAt), frequency: "DAILY", source: row.dataSource ?? row.dataProvider ?? row.provider, structural: { nav: asNumber(row.latestNav), aum: asNumber(row.aum), aumCurrency: row.currency, expenseRatio: asNumber(row.expenseRatio), category: row.category, holdingsCoverage: row.holdings.length ? "PARTIAL" : "UNAVAILABLE", holdingsAsOfDate: asIso(row.holdings[0]?.asOfDate) } };
}

async function loadFund(item: CompareRequestItem, start: Date | undefined, end: Date): Promise<LoadedItem> {
  const row = await prisma.fund.findFirst({ where: { id: item.canonicalEntityId }, include: { history: { where: { date: { ...(start ? { gte: start } : {}), lte: end } }, orderBy: { date: "asc" }, take: 5000 } } });
  if (!row) throw new WebDataError("NOT_FOUND", "Canonical fund not found.");
  const source = row.lastNavSource ?? row.dataSource ?? row.dataProvider;
  const observations = row.history.flatMap((entry) => { const value = point(entry.date, entry.nav, source, row.isin ?? row.id, entry.createdAt); return value ? [value] : []; });
  return { request: item, identity: { assetType: "FUND", canonicalEntityId: row.id, symbolOrCode: row.code ?? row.isin ?? row.id, name: row.name, currency: row.currency, market: row.domicile }, currentValue: asNumber(row.latestNav), currentValueSemantic: "NAV", returnSemantic: "NAV_RETURN", observations, effectiveAsOfDate: asIso(row.latestNavDate ?? row.navUpdatedAt), lastCanonicalUpdatedAt: asIso(row.updatedAt), frequency: "AVAILABLE_DATES", source, structural: { aum: asNumber(row.aum), aumCurrency: row.currency, expenseRatio: asNumber(row.expenseRatio), category: row.category, shareClassIdentity: { isin: row.isin, code: row.code } } };
}

async function loadIndex(item: CompareRequestItem, start: Date | undefined, end: Date): Promise<LoadedItem> {
  const identities = await prisma.$queryRaw<IndexIdentityRow[]>(Prisma.sql`SELECT id, symbol, name, currency, exchange, updated_at FROM global_index_registry WHERE id = ${item.canonicalEntityId} LIMIT 1`);
  const row = identities[0];
  if (!row) throw new WebDataError("NOT_FOUND", "Canonical index not found.");
  const rows = await prisma.$queryRaw<IndexPointRow[]>(Prisma.sql`SELECT timestamp, close, source, source_record_id, ingested_at FROM global_index_candles WHERE index_id = ${row.id} AND timestamp <= ${end} ${start ? Prisma.sql`AND timestamp >= ${start}` : Prisma.empty} ORDER BY timestamp ASC LIMIT 5000`);
  const observations = rows.flatMap((entry) => { const value = point(entry.timestamp, entry.close, entry.source, entry.source_record_id, entry.ingested_at); return value ? [value] : []; });
  return { request: item, identity: { assetType: "INDEX", canonicalEntityId: row.id, symbolOrCode: row.symbol, name: row.name, currency: row.currency, market: row.exchange }, currentValue: observations.at(-1)?.value ?? null, currentValueSemantic: "INDEX_LEVEL", returnSemantic: "INDEX_RETURN", observations, effectiveAsOfDate: observations.at(-1)?.date ?? null, lastCanonicalUpdatedAt: asIso(row.updated_at), frequency: "DAILY", source: observations.at(-1)?.source ?? null, structural: {} };
}

async function loadFx(item: CompareRequestItem, start: Date | undefined, end: Date): Promise<LoadedItem> {
  const row = await prisma.marketMaster.findFirst({ where: { id: item.canonicalEntityId, assetType: "FOREX" } });
  if (!row) throw new WebDataError("NOT_FOUND", "Canonical FX pair not found.");
  const rows = await prisma.marketData.findMany({ where: { symbol: row.symbol, type: "FOREX", date: { ...(start ? { gte: start } : {}), lte: end } }, orderBy: { date: "asc" }, take: 5000 });
  const observations = rows.flatMap((entry) => { const value = point(entry.date, entry.close, entry.source, row.symbol, entry.createdAt); return value ? [value] : []; });
  return { request: item, identity: { assetType: "FX", canonicalEntityId: row.id, symbolOrCode: row.symbol, name: row.name, currency: row.currency, market: row.exchange }, currentValue: observations.at(-1)?.value ?? asNumber(row.latestClose), currentValueSemantic: "FX_RATE", returnSemantic: "FX_RETURN", observations, effectiveAsOfDate: observations.at(-1)?.date ?? asIso(row.latestDate), lastCanonicalUpdatedAt: asIso(row.updatedAt), frequency: "DAILY", source: observations.at(-1)?.source ?? row.provider, structural: {} };
}

async function loadCrypto(item: CompareRequestItem, start: Date | undefined, end: Date): Promise<LoadedItem> {
  const identities = await prisma.$queryRaw<CryptoIdentityRow[]>(Prisma.sql`SELECT a.id, a.name, a.symbol, m.id AS market_id, q.symbol AS quote_symbol, m.exchange_id, a.updated_at FROM crypto_assets a JOIN crypto_markets m ON m.id = a.primary_market_id LEFT JOIN crypto_assets q ON q.id = m.quote_asset_id WHERE a.id = ${item.canonicalEntityId} AND a.active IS TRUE LIMIT 1`);
  const row = identities[0];
  if (!row) throw new WebDataError("NOT_FOUND", "Canonical crypto primary market not found.");
  const rows = await prisma.$queryRaw<CryptoPointRow[]>(Prisma.sql`SELECT open_time, close, source, source_record_id, updated_at FROM crypto_candles WHERE market_id = ${row.market_id} AND interval = '1d' AND open_time <= ${end} ${start ? Prisma.sql`AND open_time >= ${start}` : Prisma.empty} ORDER BY open_time ASC LIMIT 5000`);
  const observations = rows.flatMap((entry) => { const value = point(entry.open_time, entry.close, entry.source, entry.source_record_id, entry.updated_at); return value ? [value] : []; });
  return { request: item, identity: { assetType: "CRYPTO", canonicalEntityId: row.id, symbolOrCode: row.symbol, name: row.name, currency: row.quote_symbol, market: row.exchange_id }, currentValue: observations.at(-1)?.value ?? null, currentValueSemantic: "CRYPTO_PRICE", returnSemantic: "CRYPTO_PRICE_RETURN", observations, effectiveAsOfDate: observations.at(-1)?.date ?? null, lastCanonicalUpdatedAt: asIso(row.updated_at), frequency: "DAILY", source: observations.at(-1)?.source ?? null, structural: {} };
}

async function loadItem(item: CompareRequestItem, start: Date | undefined, end: Date): Promise<LoadedItem> {
  if (item.assetType === "STOCK") return loadStock(item, start, end);
  if (item.assetType === "ETF") return loadEtf(item, start, end);
  if (item.assetType === "FUND") return loadFund(item, start, end);
  if (item.assetType === "INDEX") return loadIndex(item, start, end);
  if (item.assetType === "FX") return loadFx(item, start, end);
  return loadCrypto(item, start, end);
}

function annualization(item: LoadedItem): number { return item.frequency === "DAILY" ? item.request.assetType === "CRYPTO" ? 365 : 252 : 252; }

export async function compareAssets(contractOrItems: CompareContract | CompareRequestItem[]) {
  const contract: CompareContract = Array.isArray(contractOrItems) ? { items: contractOrItems, period: "1Y", alignmentPolicy: "EXACT_INTERSECTION", normalizationPolicy: "NATIVE_NOT_NORMALIZED" } : contractOrItems;
  validateContract(contract);
  const window = resolveWindow(contract);
  const end = new Date(`${window.endDate}T23:59:59.999Z`);
  const start = window.startDate ? new Date(`${window.startDate}T00:00:00.000Z`) : undefined;
  const settled = await Promise.allSettled(contract.items.map((item) => loadItem(item, start, end)));
  const loaded = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failures = settled.flatMap((result, index) => result.status === "rejected" ? [{ request: contract.items[index], status: "DATA_UNAVAILABLE" as const, error: { code: "DATA_UNAVAILABLE", message: result.reason instanceof WebDataError ? result.reason.message : "Canonical item is unavailable." } }] : []);
  const currencies = [...new Set(loaded.flatMap((item) => item.identity.currency ? [item.identity.currency] : []))];
  if (contract.normalizationPolicy === "SAME_CURRENCY" && currencies.length > 1) throw new WebDataError("INVALID_QUERY", "SAME_CURRENCY comparison contains multiple currencies.");
  const normalizationReady = contract.normalizationPolicy !== "FX_NORMALIZED" || currencies.every((currency) => currency === contract.baseCurrency);
  const items = loaded.map((item) => {
    const observations = normalizeObservations(item.observations, window.startDate, window.endDate);
    const analytics = seriesMetrics(observations, annualization(item));
    const effective = observations.at(-1)?.date ?? item.effectiveAsOfDate;
    return {
      request: item.request,
      status: "AVAILABLE" as const,
      data: {
        identity: item.identity,
        effectiveAsOfDate: effective,
        currentValue: item.currentValue,
        currentValueSemantic: item.currentValueSemantic,
        currency: item.identity.currency,
        returnSemantic: item.returnSemantic,
        period: contract.period,
        window: { requestedStartDate: window.startDate, requestedEndDate: window.endDate, startObservationDate: observations[0]?.date ?? null, endObservationDate: observations.at(-1)?.date ?? null },
        metrics: {
          cumulativeReturn: { value: analytics.cumulativeReturn, status: analytics.status, semantic: item.returnSemantic, calculationVersion: COMPARE_CALCULATION_VERSION },
          annualizedReturn: { value: analytics.annualizedReturn, status: analytics.annualizedReturn === null ? "NOT_APPLICABLE" : analytics.status, semantic: item.returnSemantic, calculationVersion: COMPARE_CALCULATION_VERSION },
          volatility: { value: analytics.volatility, status: analytics.status, observationFrequency: item.frequency, sampleCount: analytics.sampleCount, annualizationFactor: annualization(item), calculationVersion: COMPARE_CALCULATION_VERSION },
          sharpe: { value: null, status: "NOT_READY", reason: "VERIFIED_RISK_FREE_RATE_CONTRACT_REQUIRED" },
          maxDrawdown: { value: analytics.maxDrawdown, status: analytics.status, ...analytics.drawdown, calculationVersion: COMPARE_CALCULATION_VERSION },
        },
        normalizedGrowth: analytics.normalizedGrowth,
        structural: item.structural,
        freshness: { lastCanonicalDataDate: effective, lastCanonicalUpdatedAt: item.lastCanonicalUpdatedAt },
        provenance: { canonicalRelations: item.request.assetType === "STOCK" ? ["stocks", "stock_history"] : item.request.assetType === "ETF" ? ["etfs", "etf_history"] : item.request.assetType === "FUND" ? ["funds", "fund_history"] : item.request.assetType === "INDEX" ? ["global_index_registry", "global_index_candles"] : item.request.assetType === "FX" ? ["market_master", "market_data"] : ["crypto_assets", "crypto_markets", "crypto_candles"], source: item.source, sourceType: "CANONICAL_DB", calculationVersion: COMPARE_CALCULATION_VERSION },
        coverageStatus: observations.length > 1 ? "READY" : "INSUFFICIENT_HISTORY",
      },
    };
  });
  const pairwise = loaded.flatMap((left, leftIndex) => loaded.slice(leftIndex + 1).map((right) => {
    const leftSeries = normalizeObservations(left.observations, window.startDate, window.endDate);
    const rightSeries = normalizeObservations(right.observations, window.startDate, window.endDate);
    const compatible = left.returnSemantic === right.returnSemantic || contract.items.some((item) => item.assetType !== contract.items[0].assetType);
    const result = compatible ? correlation(leftSeries, rightSeries) : { status: "NOT_COMPARABLE" as const, value: null, sampleCount: 0, startDate: null, endDate: null };
    return { leftEntity: left.identity.canonicalEntityId, rightEntity: right.identity.canonicalEntityId, metricCode: "RETURN_CORRELATION", value: result.value, sampleCount: result.sampleCount, alignmentPolicy: "EXACT_INTERSECTION" as const, startDate: result.startDate, endDate: result.endDate, qualityStatus: result.status, calculationVersion: COMPARE_CALCULATION_VERSION };
  }));
  const watermarks = Object.fromEntries(loaded.map((item) => [`${item.request.assetType}:${item.request.canonicalEntityId}`, item.lastCanonicalUpdatedAt]));
  const hash = requestHash(contract, watermarks, COMPARE_CALCULATION_VERSION);
  return {
    data: [...items, ...failures],
    pairwise,
    meta: {
      snapshotId: hash,
      requestHash: hash,
      requestedCount: contract.items.length,
      availableCount: items.length,
      partial: failures.length > 0,
      period: contract.period,
      startDate: window.startDate,
      endDate: window.endDate,
      requestedAsOfDate: contract.requestedAsOfDate ?? null,
      alignmentPolicy: contract.alignmentPolicy,
      normalizationPolicy: contract.normalizationPolicy,
      baseCurrency: contract.baseCurrency ?? null,
      crossCurrencyWarning: currencies.length > 1 && contract.normalizationPolicy === "NATIVE_NOT_NORMALIZED",
      normalizationStatus: normalizationReady ? contract.normalizationPolicy : "NOT_NORMALIZED",
      currencyHandling: currencies.length > 1 ? normalizationReady ? "MULTI_CURRENCY_POLICY_APPLIED" : "CROSS_CURRENCY_NOT_NORMALIZED" : "SAME_CURRENCY",
      upstreamWatermarks: watermarks,
      qualityStatus: items.length === contract.items.length && items.every((item) => item.data.coverageStatus === "READY") ? "READY" : "PARTIAL",
      generatedAt: new Date().toISOString(),
      calculationVersion: COMPARE_CALCULATION_VERSION,
    },
    error: null,
  };
}

export function parseCompareItems(value: string): CompareRequestItem[] {
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length < MIN_COMPARE_ITEMS || tokens.length > MAX_COMPARE_ITEMS) throw new WebDataError("INVALID_QUERY", `Compare requires ${MIN_COMPARE_ITEMS} to ${MAX_COMPARE_ITEMS} items.`);
  return tokens.map((token) => {
    const separator = token.indexOf(":");
    const assetType = token.slice(0, separator).toUpperCase() as CompareAssetType;
    const canonicalEntityId = token.slice(separator + 1).trim();
    if (separator < 1 || !COMPARE_ASSET_TYPES.includes(assetType) || !canonicalEntityId) throw new WebDataError("INVALID_QUERY", "Invalid compare item format.");
    return { assetType, canonicalEntityId };
  });
}

export function parseCompareContract(url: URL): CompareContract {
  const period = (url.searchParams.get("period") ?? "1Y").toUpperCase() as ComparePeriod;
  const alignmentPolicy = (url.searchParams.get("alignmentPolicy") ?? "EXACT_INTERSECTION") as AlignmentPolicy;
  const normalizationPolicy = (url.searchParams.get("normalizationPolicy") ?? "NATIVE_NOT_NORMALIZED") as NormalizationPolicy;
  return { items: parseCompareItems(url.searchParams.get("items") ?? ""), period, startDate: url.searchParams.get("startDate"), endDate: url.searchParams.get("endDate"), requestedAsOfDate: url.searchParams.get("requestedAsOfDate"), baseCurrency: url.searchParams.get("baseCurrency")?.toUpperCase() ?? null, alignmentPolicy, normalizationPolicy };
}

// Result payload shapes, derived from the compareAssets() return type so they stay in sync.
export type CompareResult = Awaited<ReturnType<typeof compareAssets>>;
export type CompareItemResult = CompareResult["data"][number];
