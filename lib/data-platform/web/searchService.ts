import { localizedNameZhTw } from "@/lib/web/localized-name-zh-tw";
import { WebDataError } from "./errors.ts";
import { searchEtfs } from "./etfService.ts";
import { searchFunds } from "./fundService.ts";
import { searchFx } from "./fxService.ts";
import { searchIndices } from "./indexService.ts";
import { searchStocks } from "./stockService.ts";
import { prisma } from "../../prisma.ts";
import { listGovernmentYieldSeries } from "../../services/governmentYieldService.ts";
import { buildProvenance } from "./provenance.ts";
import type { CoverageStatus, FreshnessStatus, Provenance } from "./types.ts";

export const SEARCH_ASSET_TYPES = ["STOCK", "ETF", "FUND", "INDEX", "DERIVATIVES", "FIXED_INCOME", "FX", "MACRO", "COMMODITY", "CRYPTO"] as const;
export type SearchAssetType = typeof SEARCH_ASSET_TYPES[number];
export type SearchType = "ALL" | SearchAssetType;
export const DEFAULT_TOTAL_LIMIT = 30;
export const MAX_TOTAL_LIMIT = 50;
export const MAX_PER_DOMAIN = 10;
const MAX_CANDIDATES_PER_DOMAIN = 50;
const MAX_MACRO_CANDIDATES = 500;

export interface UnifiedSearchResult {
  assetType: SearchAssetType;
  canonicalId: string;
  symbolOrCode: string | null;
  name: string;
  displayName: string;
  market: string | null;
  exchange: string | null;
  country: string | null;
  currency: string | null;
  latestValue: number | null;
  changePercent: number | null;
  asOfDate: string | null;
  lastUpdated: string | null;
  freshnessStatus: FreshnessStatus;
  coverageStatus: CoverageStatus;
  source: string | null;
  provenance: Provenance;
  detailHref: string | null;
  publicReady: boolean;
}

export interface GlobalSearchResponse {
  data: UnifiedSearchResult[];
  meta: { query: string; typesSearched: SearchAssetType[]; resultCount: number; partial: boolean; failedDomains: SearchAssetType[]; asOfDate: string | null; generatedAt: string };
  error: null;
}

type SearchableRow = { publicReady?: boolean; identity: { assetType: SearchAssetType; id: string; symbol: string; name: string; displayName: string; currency: string | null; market: string | null; country: string | null }; metrics: { priceOrNav: number | null; changePercent: number | null; asOfDate: string | null }; freshnessStatus?: FreshnessStatus; source?: string | null };
type DomainPayload = { data: SearchableRow[] | null; meta: { freshnessStatus: FreshnessStatus; source: string | null; asOfDate: string | null; lastUpdated: string | null; coverageStatus: CoverageStatus; provenance: Provenance } };

const identityPayload = (data: SearchableRow[], source: string | null = null): DomainPayload => ({
  data,
  meta: { freshnessStatus: "UNKNOWN", source, asOfDate: null, lastUpdated: null, coverageStatus: "PARTIAL_CURRENT", provenance: buildProvenance({ source }) },
});
const emptyMetrics = { priceOrNav: null, changePercent: null, asOfDate: null };

async function searchDerivatives(query: string): Promise<DomainPayload> {
  const contains = { contains: query, mode: "insensitive" as const };
  const [futures, options] = await Promise.all([
    prisma.futuresContract.findMany({ where: { OR: [{ contractSymbol: contains }, { underlying: contains }] }, orderBy: [{ expiration: "asc" }, { id: "asc" }], take: MAX_CANDIDATES_PER_DOMAIN }),
    prisma.optionContract.findMany({ where: { OR: [{ contractSymbol: contains }, { underlying: contains }] }, orderBy: [{ expiration: "asc" }, { id: "asc" }], take: MAX_CANDIDATES_PER_DOMAIN }),
  ]);
  return identityPayload([
    ...futures.map((row) => ({ identity: { assetType: "DERIVATIVES" as const, id: row.id, symbol: row.contractSymbol, name: row.contractSymbol, displayName: `${row.underlying} ${row.contractSymbol}`, currency: row.currency, market: row.exchange, country: null }, metrics: emptyMetrics, source: row.source })),
    ...options.map((row) => ({ identity: { assetType: "DERIVATIVES" as const, id: row.id, symbol: row.contractSymbol, name: row.contractSymbol, displayName: `${row.underlying} ${row.callPut} ${row.strike}`, currency: row.currency, market: row.exchange, country: null }, metrics: emptyMetrics, source: null })),
  ]);
}

async function searchFixedIncome(query: string): Promise<DomainPayload> {
  const rows = await listGovernmentYieldSeries({ query }) as Array<Record<string, unknown>>;
  return identityPayload(rows.slice(0, MAX_CANDIDATES_PER_DOMAIN).map((row) => ({
    identity: { assetType: "FIXED_INCOME" as const, id: String(row.canonicalId), symbol: String(row.canonicalId), name: String(row.officialName), displayName: String(row.officialName), currency: String(row.currency ?? ""), market: String(row.authority ?? ""), country: String(row.jurisdiction ?? "") },
    metrics: emptyMetrics,
    source: typeof row.officialSource === "string" ? row.officialSource : null,
  })));
}

async function searchMacro(query: string): Promise<DomainPayload> {
  const contains = { contains: query, mode: "insensitive" as const };
  const rows = await prisma.economicSeries.findMany({ where: { OR: [{ seriesId: contains }, { code: contains }, { name: contains }] }, orderBy: [{ name: "asc" }, { id: "asc" }], take: MAX_MACRO_CANDIDATES });
  return identityPayload(rows.map((row) => ({ identity: { assetType: "MACRO" as const, id: row.id, symbol: row.seriesId, name: row.name, displayName: row.name, currency: null, market: row.provider, country: row.country }, metrics: emptyMetrics, source: row.source })));
}

async function searchMarketDomain(query: string, assetType: "COMMODITY" | "CRYPTO"): Promise<DomainPayload> {
  const contains = { contains: query, mode: "insensitive" as const };
  const rows = await prisma.marketMaster.findMany({ where: { assetType, OR: [{ symbol: contains }, { name: contains }, { nameZh: contains }] }, orderBy: [{ name: "asc" }, { id: "asc" }], take: MAX_CANDIDATES_PER_DOMAIN });
  return identityPayload(rows.map((row) => ({ identity: { assetType, id: row.id, symbol: row.symbol, name: row.name, displayName: row.nameZh ?? row.name, currency: row.currency, market: row.exchange, country: row.country ?? row.region }, metrics: emptyMetrics, source: row.provider })));
}

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9\p{L}]+/gu, "");
const words = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US").split(/[^a-z0-9\p{L}]+/gu).filter(Boolean);
const hrefFor = (type: SearchAssetType, symbol: string) => {
  const encoded = encodeURIComponent(symbol);
  if (type === "STOCK") return `/stocks/${encoded}`;
  if (type === "ETF") return `/etf/${encoded}`;
  if (type === "FUND") return `/funds?q=${encoded}`;
  if (type === "INDEX") return `/indices/${encoded}`;
  return `/markets?q=${encoded}`;
};
const rank = (row: UnifiedSearchResult, query: string) => {
  const term = normalize(query);
  const rawTerm = query.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const rawSymbol = (row.symbolOrCode ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const symbol = normalize(row.symbolOrCode ?? "");
  const name = normalize(row.name);
  const display = normalize(row.displayName);
  const taiwanBareCode = /^\d{4,6}$/.test(rawTerm);
  const taiwanSymbol = /\.(tw|two)$/i.test(rawSymbol);
  const taiwanIdentity = row.country === "TW" || /taiwan|twse|tpex/i.test(`${row.country ?? ""} ${row.market ?? ""} ${row.exchange ?? ""}`);
  const tsmcAlias = ["台積電", "台灣積體電路", "tsmc"].includes(rawTerm);
  if ((taiwanBareCode && taiwanSymbol && rawSymbol.replace(/\.(tw|two)$/i, "") === rawTerm) || (tsmcAlias && rawSymbol === "2330.tw")) return -2;
  if (rawSymbol === rawTerm) return 0;
  if (symbol === term) return 1;
  if (taiwanBareCode && taiwanIdentity && symbol.startsWith(term)) return 1;
  if (row.assetType === "MACRO" && term === "gdp" && (name.includes("grossdomesticproduct") || display.includes("grossdomesticproduct"))) return 2;
  if (name === term || display === term) return 2;
  if (symbol.startsWith(term)) return 3;
  if (name.startsWith(term) || display.startsWith(term)) return 4;
  if (words(row.name).includes(rawTerm) || words(row.displayName).includes(rawTerm)) return 5;
  return 6;
};
const domainTieRank = (row: UnifiedSearchResult, query: string) => normalize(query).length === 3 && row.assetType === "FX" ? 0 : 1;
// Primary-listing tiebreak (STOCK only): when a name/ticker search ties on `rank`, a company's primary
// listing (NASDAQ/NYSE/TWSE/TPEx) should outrank secondary foreign listings and trackers on the same
// name (e.g. "Microsoft" was surfacing an LSE cross-listing ahead of NASDAQ:MSFT). Same primary-exchange
// set already used by current-market-data's own ORDER BY CASE — kept consistent rather than inventing a
// second convention. ETF/FUND/etc. results are unaffected (they don't have this multi-listing problem).
const PRIMARY_STOCK_EXCHANGES = new Set(["NASDAQ", "NYSE", "TWSE", "TPEx", "TPEX"]);
const primaryListingRank = (row: UnifiedSearchResult) => row.assetType !== "STOCK" ? 0 : PRIMARY_STOCK_EXCHANGES.has(row.exchange ?? "") ? 0 : 1;

const runners: Record<SearchAssetType, (query: string) => Promise<DomainPayload>> = {
  STOCK: (query) => searchStocks(query, { page: 1, pageSize: MAX_CANDIDATES_PER_DOMAIN }) as Promise<DomainPayload>,
  ETF: (query) => searchEtfs(query, { page: 1, pageSize: MAX_PER_DOMAIN }) as Promise<DomainPayload>,
  FUND: (query) => searchFunds(query, { page: 1, pageSize: MAX_PER_DOMAIN }) as Promise<DomainPayload>,
  INDEX: (query) => searchIndices(query, { page: 1, pageSize: MAX_CANDIDATES_PER_DOMAIN }) as Promise<DomainPayload>,
  DERIVATIVES: searchDerivatives,
  FIXED_INCOME: searchFixedIncome,
  FX: (query) => searchFx(query, { page: 1, pageSize: MAX_CANDIDATES_PER_DOMAIN }) as Promise<DomainPayload>,
  MACRO: searchMacro,
  COMMODITY: (query) => searchMarketDomain(query, "COMMODITY"),
  CRYPTO: (query) => searchMarketDomain(query, "CRYPTO"),
};

export async function globalSearch(input: { query: string; type?: SearchType; limit?: number }): Promise<GlobalSearchResponse> {
  const query = input.query.trim();
  if (!query || query.length > 100) throw new WebDataError("INVALID_QUERY", "Search query must contain between 1 and 100 characters.");
  const type = input.type ?? "ALL";
  if (type !== "ALL" && !SEARCH_ASSET_TYPES.includes(type)) throw new WebDataError("INVALID_QUERY", "Unsupported asset type.");
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_TOTAL_LIMIT), 1), MAX_TOTAL_LIMIT);
  const types = type === "ALL" ? [...SEARCH_ASSET_TYPES] : [type];
  const stockQuery = ["tsmc", "台灣積體電路"].includes(normalize(query)) ? "2330.TW" : query;
  const settled = await Promise.allSettled(types.map(async (assetType) => ({ assetType, response: await runners[assetType](assetType === "STOCK" ? stockQuery : query) })));
  const failedDomains: SearchAssetType[] = [];
  const results: UnifiedSearchResult[] = [];
  const dates: string[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index];
    const assetType = types[index];
    if (outcome.status === "rejected") { failedDomains.push(assetType); continue; }
    const response = outcome.value.response;
    if (response.meta.asOfDate) dates.push(response.meta.asOfDate);
    for (const row of response.data ?? []) {
      const source = row.source ?? response.meta.source;
      const asOfDate = row.metrics.asOfDate ?? response.meta.asOfDate;
      const provenance = buildProvenance({ source, sourceRecordId: row.identity.id, asOfDate, lastUpdated: response.meta.lastUpdated });
      const effectiveFreshness=row.freshnessStatus ?? response.meta.freshnessStatus; const publicReady=row.publicReady ?? (["STOCK","ETF"].includes(assetType) && row.metrics.priceOrNav !== null && Boolean(asOfDate) && response.meta.coverageStatus === "FULL" && !["UNKNOWN","UNAVAILABLE","STALE"].includes(effectiveFreshness)); results.push({ assetType, canonicalId: row.identity.id, symbolOrCode: row.identity.symbol || null, name: row.identity.name, displayName: localizedNameZhTw(row.identity.symbol, row.identity.displayName), market: row.identity.market, exchange: row.identity.market, country: row.identity.country, currency: row.identity.currency, latestValue: row.metrics.priceOrNav, changePercent: row.metrics.changePercent, asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: effectiveFreshness, coverageStatus: response.meta.coverageStatus, source, provenance, publicReady, detailHref: publicReady ? hrefFor(assetType, row.identity.symbol) : null });
    }
  }
  if (failedDomains.length === types.length) throw new WebDataError("DATA_UNAVAILABLE", "Canonical search domains are temporarily unavailable.");
  const unique = [...new Map(results.map((row) => [`${row.assetType}:${row.canonicalId}`, row])).values()];
  unique.sort((left, right) => rank(left, query) - rank(right, query) || domainTieRank(left, query) - domainTieRank(right, query) || primaryListingRank(left) - primaryListingRank(right) || left.assetType.localeCompare(right.assetType) || (left.symbolOrCode ?? "").localeCompare(right.symbolOrCode ?? "") || left.canonicalId.localeCompare(right.canonicalId));
  return { data: unique.slice(0, limit), meta: { query, typesSearched: types, resultCount: Math.min(unique.length, limit), partial: failedDomains.length > 0, failedDomains, asOfDate: dates.sort().at(-1) ?? null, generatedAt: new Date().toISOString() }, error: null };
}



