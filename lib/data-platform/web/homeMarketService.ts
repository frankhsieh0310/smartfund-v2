import { prisma } from "../../prisma.ts";
import { freshnessStatus } from "./freshness.ts";
import { getFxSummaries } from "./fxService.ts";
import { getIndexList, getIndexSummaries } from "./indexService.ts";
import { buildProvenance } from "./provenance.ts";
import { numberOrNull, type CoverageStatus, type FreshnessStatus, type Provenance } from "./types.ts";

export type HomeMarketAssetType = "INDEX" | "YIELD" | "FX" | "COMMODITY" | "VOLATILITY" | "RATE" | "CRYPTO";
export type HomeMarketTab = "stocks" | "bonds" | "fx" | "commodities" | "crypto";

export interface HomeMarketCard {
  assetType: HomeMarketAssetType;
  id: string;
  label: string;
  symbolOrCode: string | null;
  value: number | null;
  change: number | null;
  changePercent: number | null;
  unit: string | null;
  currency: string | null;
  asOfDate: string | null;
  lastUpdated: string | null;
  freshnessStatus: FreshnessStatus;
  source: string | null;
  provenance: Provenance;
  detailHref: string | null;
  coverageStatus: CoverageStatus;
}

export interface HomeMarketOverview {
  tabs: Record<HomeMarketTab, HomeMarketCard[]>;
  available: Record<HomeMarketTab, HomeMarketCard[]>;
  indexRegistryCount: number;
  unavailableDomains: HomeMarketAssetType[];
  generatedAt: string;
}

async function availableIndexCards(): Promise<{ cards: HomeMarketCard[]; total: number }> {
  const [result, registryTotal] = await Promise.all([
    getIndexList({ page: 1, pageSize: 200 }),
    prisma.globalIndexRegistry.count({ where: { active: true } }),
  ]);
  return {
    total: registryTotal,
    cards: result.data.filter((row) => row.publicReady).map((row) => ({
      assetType: "INDEX", id: row.identity.id, label: row.identity.displayName,
      symbolOrCode: row.identity.symbol, value: row.metrics.priceOrNav,
      change: row.metrics.change, changePercent: row.metrics.changePercent,
      unit: null, currency: row.metrics.currency, asOfDate: row.metrics.asOfDate,
      lastUpdated: result.meta.lastUpdated, freshnessStatus: result.meta.freshnessStatus,
      source: result.meta.source, provenance: result.meta.provenance,
      detailHref: `/indices/${encodeURIComponent(row.identity.symbol)}`, coverageStatus: "FULL",
    })),
  };
}
const INDEX_SYMBOLS = ["^GSPC", "^IXIC", "^N225", "^TWII"] as const;
const FX_SYMBOLS = ["USDTWD=X", "EURUSD=X", "JPY=X"] as const;
const YIELD_SERIES = ["DGS2", "DGS10", "DGS30"] as const;
const RATE_SERIES = ["SOFR", "FEDFUNDS"] as const;
const COMMODITY_SYMBOLS = ["GOLD", "WTI", "BRENT", "COPPER"] as const;
const CRYPTO_SYMBOLS = ["BTC-USD", "ETH-USD"] as const;

const unavailable = (assetType: HomeMarketAssetType, id: string, label: string, symbolOrCode: string): HomeMarketCard => ({
  assetType, id, label, symbolOrCode, value: null, change: null, changePercent: null, unit: null, currency: null,
  asOfDate: null, lastUpdated: null, freshnessStatus: "UNKNOWN", source: null, provenance: buildProvenance({ sourceRecordId: id }), detailHref: null, coverageStatus: "UNKNOWN",
});

async function indexCards(): Promise<HomeMarketCard[]> {
  const rows = await getIndexSummaries(INDEX_SYMBOLS);
  const bySymbol = new Map(rows.map((row) => [row.data.identity.symbol, row]));
  return INDEX_SYMBOLS.flatMap((symbol) => {
    const row = bySymbol.get(symbol);
    if (!row) return unavailable("INDEX", symbol, symbol, symbol);
    return { assetType: "INDEX", id: row.data.identity.id, label: row.data.identity.displayName, symbolOrCode: symbol, value: row.data.metrics.priceOrNav, change: row.data.metrics.change, changePercent: row.data.metrics.changePercent, unit: null, currency: row.data.metrics.currency, asOfDate: row.meta.asOfDate, lastUpdated: row.meta.lastUpdated, freshnessStatus: row.meta.freshnessStatus, source: row.meta.source, provenance: row.meta.provenance, detailHref: null, coverageStatus: row.meta.coverageStatus };
  });
}

async function fxCards(): Promise<HomeMarketCard[]> {
  const rows = await getFxSummaries(FX_SYMBOLS);
  const bySymbol = new Map(rows.map((row) => [row.data.identity.symbol, row]));
  return FX_SYMBOLS.map((symbol) => {
    const row = bySymbol.get(symbol);
    if (!row) return unavailable("FX", symbol, symbol.replace("=X", ""), symbol);
    return { assetType: "FX", id: row.data.identity.id, label: row.data.identity.name, symbolOrCode: symbol, value: row.data.metrics.priceOrNav, change: row.data.metrics.change, changePercent: row.data.metrics.changePercent, unit: null, currency: row.data.metrics.currency, asOfDate: row.meta.asOfDate, lastUpdated: row.meta.lastUpdated, freshnessStatus: row.meta.freshnessStatus, source: row.meta.source, provenance: row.meta.provenance, detailHref: null, coverageStatus: row.meta.coverageStatus };
  });
}

async function economicCards(seriesIds: readonly string[], assetType: "YIELD" | "RATE"): Promise<HomeMarketCard[]> {
  const rows = await prisma.economicSeries.findMany({
    where: { enabled: true, seriesId: { in: [...seriesIds] } },
    select: { id: true, seriesId: true, name: true, unit: true, source: true, provider: true, frequency: true, updatedAt: true, values: { orderBy: { date: "desc" }, take: 1, select: { date: true, value: true, updatedAt: true, importedAt: true } } },
  });
  const bySeries = new Map(rows.map((row) => [row.seriesId, row]));
  return seriesIds.map((seriesId) => {
    const row = bySeries.get(seriesId);
    if (!row) return unavailable(assetType, seriesId, seriesId, seriesId);
    const latest = row.values[0];
    const source = row.provider || row.source;
    const provenance = buildProvenance({ source, sourceRecordId: seriesId, asOfDate: latest?.date, lastUpdated: latest?.updatedAt ?? latest?.importedAt ?? row.updatedAt });
    return { assetType, id: row.id, label: row.name, symbolOrCode: seriesId, value: numberOrNull(latest?.value), change: null, changePercent: null, unit: row.unit, currency: null, asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(latest?.date, "PUBLICATION_AWARE"), source, provenance, detailHref: null, coverageStatus: latest ? "FULL" : "UNKNOWN" };
  });
}

async function marketMasterCards(symbols: readonly string[], assetType: "COMMODITY" | "CRYPTO"): Promise<HomeMarketCard[]> {
  const rows = await prisma.marketMaster.findMany({ where: { assetType, isActive: true, symbol: { in: [...symbols] } }, orderBy: { symbol: "asc" } });
  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
  return symbols.map((symbol) => {
    const row = bySymbol.get(symbol);
    if (!row) return unavailable(assetType, symbol, symbol, symbol);
    const provenance = buildProvenance({ source: row.provider, sourceRecordId: row.symbol, asOfDate: row.latestDate, lastUpdated: row.updatedAt });
    return { assetType, id: row.id, label: row.name, symbolOrCode: row.symbol, value: numberOrNull(row.latestClose), change: numberOrNull(row.latestChange), changePercent: numberOrNull(row.latestChangePct), unit: null, currency: row.currency, asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(row.latestDate, assetType === "CRYPTO" ? "CONTINUOUS" : "MARKET_DAY"), source: row.provider, provenance, detailHref: null, coverageStatus: row.latestDate ? "FULL" : "UNKNOWN" };
  });
}

async function volatilityCards(): Promise<HomeMarketCard[]> {
  const row = await prisma.marketMaster.findFirst({ where: { assetType: "VOLATILITY", isActive: true, symbol: "VIX" } });
  if (!row) return [unavailable("VOLATILITY", "VIX", "CBOE Volatility Index", "VIX")];
  const provenance = buildProvenance({ source: row.provider, sourceRecordId: row.symbol, asOfDate: row.latestDate, lastUpdated: row.updatedAt });
  return [{ assetType: "VOLATILITY", id: row.id, label: row.name, symbolOrCode: row.symbol, value: numberOrNull(row.latestClose), change: numberOrNull(row.latestChange), changePercent: numberOrNull(row.latestChangePct), unit: null, currency: row.currency, asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(row.latestDate, "MARKET_DAY"), source: row.provider, provenance, detailHref: null, coverageStatus: row.latestDate ? "FULL" : "UNKNOWN" }];
}

export async function getHomeMarketOverview(): Promise<HomeMarketOverview> {
  const [results, indexAvailable] = await Promise.all([Promise.allSettled([
    indexCards(), economicCards(YIELD_SERIES, "YIELD"), fxCards(), marketMasterCards(COMMODITY_SYMBOLS, "COMMODITY"), volatilityCards(), economicCards(RATE_SERIES, "RATE"), marketMasterCards(CRYPTO_SYMBOLS, "CRYPTO"),
  ]), availableIndexCards().catch(() => ({ cards: [] as HomeMarketCard[], total: 0 }))]);
  const domains: HomeMarketAssetType[] = ["INDEX", "YIELD", "FX", "COMMODITY", "VOLATILITY", "RATE", "CRYPTO"];
  const cards = results.map((result) => result.status === "fulfilled" ? result.value : []) as HomeMarketCard[][];
  const unavailableDomains = results.flatMap((result, index) => result.status === "rejected" ? [domains[index]] : []);
  const visible = (items: HomeMarketCard[]) => items.filter((item) => item.value !== null);
  const tabs = { stocks: visible([...cards[0], ...cards[4]]), bonds: visible([...cards[1], ...cards[5]]), fx: visible(cards[2]), commodities: visible(cards[3]), crypto: visible(cards[6]) };
  return {
    tabs,
    available: { ...tabs, stocks: indexAvailable.cards.length ? indexAvailable.cards : tabs.stocks },
    indexRegistryCount: indexAvailable.total,
    unavailableDomains,
    generatedAt: new Date().toISOString(),
  };
}
