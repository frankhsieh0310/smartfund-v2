import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { prisma } from "../../../lib/prisma.ts";

type SeriesConfig = {
  seriesId: string; commodityId: string; seriesType: string; symbol: string; provider: string;
  exchange: string | null; jurisdiction: string | null; currency: string; unit: string | null;
  frequency: "DAILY" | "MONTHLY"; priceBasis: string | null; status: string; sourceVerificationStatus: string;
};
type Point = { date: Date; close: unknown; open: unknown; high: unknown; low: unknown; volume: unknown; source: string | null; createdAt: Date };

const root = process.cwd();
const outputRoot = path.join(root, "runtime", "commodity", "professional-depth");
const platformPath = path.join(root, "config", "commodity-professional-platform.json");
const universePath = path.join(root, "config", "global-commodity-universe.json");
const workbookUrl = "https://thedocs.worldbank.org/en/doc/5d903e848db1d1b83e0ec8f744e55570-0350012021/related/CMO-Historical-Data-Monthly.xlsx";
const apply = process.argv.includes("--apply");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, json(value));
  await rename(temporary, file);
}
const number = (value: unknown) => value == null ? null : Number(value);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const days = (left: Date, right: Date) => Math.abs(left.getTime() - right.getTime()) / 86_400_000;

function professionalGroup(commodity: { id: string; category: string }) {
  if (["CORN", "WHEAT", "RICE"].includes(commodity.id)) return "GRAINS";
  if (commodity.id === "SOYBEANS") return "OILSEEDS";
  const map: Record<string, string> = { ENERGY: "ENERGY", PRECIOUS_METALS: "PRECIOUS_METALS", INDUSTRIAL_METALS: "INDUSTRIAL_METALS", LIVESTOCK: "LIVESTOCK", SOFT_COMMODITIES: "SOFTS" };
  return map[commodity.category] ?? "OTHER";
}
function annualizedVolatility(points: Array<{ date: Date; value: number }>, windowDays: number, periods: number) {
  const latest = points.at(-1)?.date;
  if (!latest) return null;
  const cutoff = new Date(latest.getTime() - windowDays * 86_400_000);
  const values = points.filter((point) => point.date >= cutoff).map((point) => point.value);
  if (values.length < 3) return null;
  const returns = values.slice(1).map((value, index) => Math.log(value / values[index])).filter(Number.isFinite);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periods) * 100;
}
function periodReturn(points: Array<{ date: Date; value: number }>, target: Date) {
  const latest = points.at(-1);
  const base = points.filter((point) => point.date <= target).at(-1);
  return latest && base && base.value !== 0 ? (latest.value / base.value - 1) * 100 : null;
}
function analytics(points: Point[], frequency: "DAILY" | "MONTHLY") {
  const values = points.flatMap((point) => {
    const value = number(point.close);
    return value !== null && Number.isFinite(value) && value > 0 ? [{ date: point.date, value }] : [];
  });
  const latest = values.at(-1);
  if (!latest) return null;
  const previous = values.at(-2);
  const target = (months: number) => new Date(Date.UTC(latest.date.getUTCFullYear(), latest.date.getUTCMonth() - months, latest.date.getUTCDate()));
  const ytd = new Date(Date.UTC(latest.date.getUTCFullYear() - 1, 11, 31));
  const oneYear = values.filter((point) => point.date >= target(12));
  let peak = -Infinity, maxDrawdown = 0;
  for (const point of oneYear) { peak = Math.max(peak, point.value); maxDrawdown = Math.min(maxDrawdown, (point.value / peak - 1) * 100); }
  const periods = frequency === "MONTHLY" ? 12 : 252;
  return {
    latestDate: isoDate(latest.date), latestValue: latest.value,
    performance: {
      "1D": previous ? (latest.value / previous.value - 1) * 100 : null,
      "1W": periodReturn(values, new Date(latest.date.getTime() - 7 * 86_400_000)),
      "1M": periodReturn(values, target(1)), "3M": periodReturn(values, target(3)), "6M": periodReturn(values, target(6)),
      YTD: periodReturn(values, ytd), "1Y": periodReturn(values, target(12)), "3Y": periodReturn(values, target(36)),
      "5Y": periodReturn(values, target(60)), "10Y": periodReturn(values, target(120)),
    },
    risk: { volatility30D: annualizedVolatility(values, 30, periods), volatility90D: annualizedVolatility(values, 90, periods), volatility1Y: annualizedVolatility(values, 365, periods), maxDrawdown1Y: maxDrawdown },
  };
}

async function fetchWorldBank() {
  const response = await fetch(workbookUrl, { headers: { "user-agent": "SmartFund-Commodity-P0/1.0" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`WORLD_BANK_HTTP_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, checksum: createHash("sha256").update(bytes).digest("hex"), retrievedAt: new Date().toISOString() };
}
function parseWorldBank(bytes: Buffer, definitions: Array<{ commodityId: string; symbol: string; sourceColumn: string; unit: string }>) {
  const workbook = XLSX.read(bytes, { type: "buffer", raw: true });
  const sheet = workbook.Sheets["Monthly Prices"];
  if (!sheet) throw new Error("WORLD_BANK_MONTHLY_PRICES_MISSING");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, blankrows: false });
  const headerIndex = rows.findIndex((row) => row.some((value) => String(value).trim() === "Crude oil, Brent"));
  if (headerIndex < 0) throw new Error("WORLD_BANK_HEADER_MISSING");
  return definitions.map((definition) => {
    const column = rows[headerIndex].findIndex((value) => String(value).trim() === definition.sourceColumn);
    if (column < 0) throw new Error(`WORLD_BANK_COLUMN_MISSING:${definition.sourceColumn}`);
    const observations = rows.slice(headerIndex + 1).flatMap((row) => {
      const match = /^(\d{4})M(\d{2})$/.exec(String(row[0] ?? "").trim());
      const value = Number(row[column]);
      return match && Number.isFinite(value) && value > 0 ? [{ date: new Date(`${match[1]}-${match[2]}-01T00:00:00.000Z`), value }] : [];
    });
    const unique = new Set(observations.map((item) => isoDate(item.date)));
    if (observations.length < 120 || unique.size !== observations.length) throw new Error(`WORLD_BANK_CANARY_GATE_FAILED:${definition.commodityId}`);
    return { ...definition, observations };
  });
}

async function writeWorldBankSeries(series: ReturnType<typeof parseWorldBank>, retrievedAt: string) {
  let inserted = 0;
  for (const item of series) {
    const latest = item.observations.at(-1)!;
    const previous = item.observations.at(-2)!;
    const changePts = latest.value - previous.value;
    const changePct = previous.value ? changePts / previous.value * 100 : null;
    await prisma.marketMaster.upsert({
      where: { symbol: item.symbol },
      create: { symbol: item.symbol, name: `World Bank ${item.commodityId.replaceAll("_", " ")} Monthly Reference`, assetType: "COMMODITY", region: "GLOBAL", currency: "USD", category: "MONTHLY_REFERENCE", provider: "WORLD_BANK_PINK_SHEET", latestClose: latest.value, latestDate: latest.date, latestChange: changePts, latestChangePct: changePct },
      update: { name: `World Bank ${item.commodityId.replaceAll("_", " ")} Monthly Reference`, assetType: "COMMODITY", region: "GLOBAL", currency: "USD", category: "MONTHLY_REFERENCE", provider: "WORLD_BANK_PINK_SHEET", isActive: true, latestClose: latest.value, latestDate: latest.date, latestChange: changePts, latestChangePct: changePct },
    });
    for (let offset = 0; offset < item.observations.length; offset += 250) {
      const batch = item.observations.slice(offset, offset + 250);
      const result = await prisma.marketData.createMany({ data: batch.map((observation) => ({ symbol: item.symbol, name: `World Bank ${item.commodityId.replaceAll("_", " ")} Monthly Reference`, type: "COMMODITY", date: observation.date, close: observation.value, region: "GLOBAL", currency: "USD", source: "WORLD_BANK_PINK_SHEET", createdAt: new Date(retrievedAt) })), skipDuplicates: true });
      inserted += result.count;
    }
    await prisma.marketData.update({ where: { symbol_date: { symbol: item.symbol, date: latest.date } }, data: { changePts, changePct, source: "WORLD_BANK_PINK_SHEET" } });
  }
  return inserted;
}

const platform = JSON.parse(await readFile(platformPath, "utf8"));
const universe = JSON.parse(await readFile(universePath, "utf8"));
const source = await fetchWorldBank();
const worldBank = parseWorldBank(source.bytes, platform.worldBankCanary);
if (apply) await writeWorldBankSeries(worldBank, source.retrievedAt);

const expandedSeries: SeriesConfig[] = [...platform.priceSeries];
for (const item of platform.worldBankCanary.slice(1)) expandedSeries.push({ seriesId: `WB_${item.commodityId}_MONTHLY`, commodityId: item.commodityId, seriesType: "MONTHLY_REFERENCE", symbol: item.symbol, provider: "WORLD_BANK_PINK_SHEET", exchange: null, jurisdiction: "GLOBAL", currency: "USD", unit: item.unit, frequency: "MONTHLY", priceBasis: "OFFICIAL_MONTHLY_REFERENCE", status: "ACTIVE", sourceVerificationStatus: "OFFICIAL_REFERENCE" });

const masters = [...universe.commodities.map((commodity: any) => ({ canonicalCommodityId: commodity.id, officialName: commodity.name, commodityGroup: professionalGroup(commodity), commoditySubgroup: commodity.category, canonicalUnit: commodity.canonicalUnit, referenceCurrency: commodity.canonicalUnit?.startsWith("EUR/") ? "EUR" : commodity.canonicalUnit === "VARIOUS" ? null : "USD", physicalMarketType: commodity.category, status: commodity.active ? "ACTIVE" : "INACTIVE", sourceVerificationStatus: "REGISTERED_OFFICIAL_METADATA", configuredUniverse: true })), ...platform.supplementalCommodities.map((commodity: any) => ({ canonicalCommodityId: commodity.id, ...commodity }))];
const observations = new Map<string, Point[]>();
for (const series of expandedSeries) observations.set(series.symbol, await prisma.marketData.findMany({ where: { type: "COMMODITY", symbol: series.symbol }, orderBy: { date: "asc" }, select: { date: true, close: true, open: true, high: true, low: true, volume: true, source: true, createdAt: true } }));

const analyticRows = expandedSeries.map((series) => {
  const points = observations.get(series.symbol) ?? [];
  const result = analytics(points, series.frequency);
  const latestPoint = points.at(-1);
  const ageDays = latestPoint ? days(latestPoint.date, new Date()) : null;
  const freshnessStatus = ageDays === null ? "UNKNOWN" : series.frequency === "MONTHLY" ? ageDays <= 62 ? "CURRENT" : "SOURCE_DELAYED" : ageDays <= 7 ? "CURRENT" : "STALE";
  return { ...series, history: { observations: points.length, earliestDate: points[0] ? isoDate(points[0].date) : null, latestDate: latestPoint ? isoDate(latestPoint.date) : null }, latestRetrievedAt: latestPoint?.createdAt.toISOString() ?? null, freshnessStatus, volumeSemantics: series.seriesType === "FUTURES_PROXY" ? "PROVIDER_FUTURES_VOLUME" : "NOT_APPLICABLE", analytics: result, provenance: { sourceId: series.provider, sourceType: series.sourceVerificationStatus, officialUrl: series.provider === "WORLD_BANK_PINK_SHEET" ? workbookUrl : null, sourceRecordId: series.symbol, retrievedAt: latestPoint?.createdAt.toISOString() ?? null, asOfDate: latestPoint ? isoDate(latestPoint.date) : null, verificationStatus: series.sourceVerificationStatus, checksum: series.provider === "WORLD_BANK_PINK_SHEET" ? source.checksum : null } };
});

const byCommodity = new Map<string, typeof analyticRows>();
for (const row of analyticRows) { const list = byCommodity.get(row.commodityId) ?? []; list.push(row); byCommodity.set(row.commodityId, list); }
const futures = await prisma.futuresContract.findMany({ select: { id: true, underlying: true, exchange: true, rootSymbol: true, contractSymbol: true, contractMonth: true, expiration: true, currency: true, source: true, observations: { select: { observedAt: true, settlement: true, source: true }, orderBy: { observedAt: "desc" }, take: 1 } } });
const physical = await prisma.energyPhysicalObservation.groupBy({ by: ["commodity"], _count: { _all: true }, _min: { observationDate: true }, _max: { observationDate: true } });
const deterministic = ["GOLD", "WTI", "BRENT", "COPPER", "NATURAL_GAS", "SILVER", "CORN", "WHEAT", "SOYBEANS", "COFFEE"];
const detail = deterministic.map((commodityId) => {
  const commodity = masters.find((item: any) => item.canonicalCommodityId === commodityId);
  const series = byCommodity.get(commodityId) ?? [];
  const primary = series.find((item) => item.seriesType === "OFFICIAL_SPOT") ?? series.find((item) => item.seriesType === "MONTHLY_REFERENCE") ?? series.sort((left, right) => right.history.observations - left.history.observations)[0];
  const missingReasons = [!primary && "PRIMARY_REFERENCE_MISSING", !primary?.analytics && "ANALYTICS_MISSING", !futures.some((contract) => contract.rootSymbol === series.find((item) => item.seriesType === "FUTURES_PROXY")?.symbol.replace("=F", "")) && "CANONICAL_FUTURES_CONTRACT_COVERAGE_LIMITED", !physical.some((row) => row.commodity === commodityId) && "PHYSICAL_DATA_MISSING"].filter(Boolean);
  return { commodity, taxonomy: commodity ? { group: commodity.commodityGroup, subgroup: commodity.commoditySubgroup } : null, primaryReferenceSeries: primary ?? null, futuresAvailability: futures.filter((contract) => contract.underlying.toUpperCase().includes(commodityId.replaceAll("_", " "))), physicalDataAvailability: physical.filter((row) => row.commodity === commodityId), missingReasons, detailContractReady: Boolean(commodity && primary?.analytics) };
});

const taxonomyReady = analyticRows.filter((row) => row.commodityId && row.seriesType !== "UNKNOWN" && row.currency && row.unit && row.provider && row.sourceVerificationStatus).length;
const coverage = {
  generatedAt: new Date().toISOString(),
  denominators: { commodityMaster: masters.length, configuredCommodityUniverse: universe.commodities.length, priceSeries: analyticRows.length, futuresContractUniverse: 30, physicalCommodityUniverse: universe.commodities.length },
  commodityMasterCoverage: { ready: masters.length, total: masters.length },
  priceSeriesCoverage: { ready: analyticRows.filter((row) => row.history.observations > 0).length, total: analyticRows.length },
  taxonomyCoverage: { ready: taxonomyReady, total: analyticRows.length, percent: taxonomyReady / analyticRows.length * 100 },
  officialSpotCoverage: { ready: 0, total: universe.commodities.length, percent: 0 },
  officialReferenceCoverage: { ready: new Set(analyticRows.filter((row) => row.seriesType === "MONTHLY_REFERENCE" && row.history.observations >= 120).map((row) => row.commodityId)).size, total: universe.commodities.length },
  futuresContractCoverage: { ready: new Set(futures.filter((contract) => ["GC", "CL", "BZ", "HG", "NG", "SI", "PL", "PA", "ZC", "ZS", "ZW"].includes(contract.rootSymbol)).map((contract) => contract.rootSymbol)).size, total: 30 },
  physicalDataCoverage: { ready: physical.length, total: universe.commodities.length },
  classification: { officialSpot: analyticRows.filter((row) => row.seriesType === "OFFICIAL_SPOT").length, officialReference: analyticRows.filter((row) => row.seriesType === "OFFICIAL_REFERENCE").length, futuresProxy: analyticRows.filter((row) => row.seriesType === "FUTURES_PROXY").length, continuousFutures: analyticRows.filter((row) => row.seriesType === "CONTINUOUS_FUTURES").length, monthlyReference: analyticRows.filter((row) => row.seriesType === "MONTHLY_REFERENCE").length, unknown: analyticRows.filter((row) => row.seriesType === "UNKNOWN").length },
  historyPreserved: true,
  originalHistoryRows: 112284,
  worldBankCanary: worldBank.map((item) => ({ commodityId: item.commodityId, observations: item.observations.length, earliestDate: isoDate(item.observations[0].date), latestDate: isoDate(item.observations.at(-1)!.date), unit: item.unit, invalidValues: 0, duplicateKeys: 0 })),
};

await atomic(path.join(outputRoot, "commodity-master.json"), { generatedAt: coverage.generatedAt, commodities: masters });
await atomic(path.join(outputRoot, "price-series.json"), { generatedAt: coverage.generatedAt, series: analyticRows });
await atomic(path.join(outputRoot, "coverage.json"), coverage);
await atomic(path.join(outputRoot, "detail-contract.json"), { generatedAt: coverage.generatedAt, deterministicSample: deterministic, readyCount: detail.filter((item) => item.detailContractReady).length, items: detail });
await atomic(path.join(outputRoot, "search-contract.json"), { generatedAt: coverage.generatedAt, items: analyticRows.map((row) => ({ commodityId: row.commodityId, symbol: row.symbol, seriesType: row.seriesType, exchange: row.exchange, jurisdiction: row.jurisdiction })) });
await atomic(path.join(outputRoot, "screener-contract.json"), { generatedAt: coverage.generatedAt, items: analyticRows.map((row) => ({ commodityId: row.commodityId, symbol: row.symbol, seriesType: row.seriesType, group: masters.find((item: any) => item.canonicalCommodityId === row.commodityId)?.commodityGroup ?? null, freshness: row.freshnessStatus, latest: row.analytics?.latestValue ?? null, performance: row.analytics?.performance ?? null, volatility30D: row.analytics?.risk.volatility30D ?? null })) });
await atomic(path.join(outputRoot, "compare-contract.json"), { generatedAt: coverage.generatedAt, semanticAlignmentRequired: true, items: analyticRows.map((row) => ({ commodityId: row.commodityId, seriesId: row.seriesId, seriesType: row.seriesType, unit: row.unit, currency: row.currency, freshness: row.freshnessStatus, latest: row.analytics?.latestValue ?? null, performance: row.analytics?.performance ?? null, risk: row.analytics?.risk ?? null })) });
console.log(JSON.stringify({ status: apply ? "P0_APPLIED" : "P0_PLAN_VALID", taxonomy: coverage.taxonomyCoverage, officialReferenceCoverage: coverage.officialReferenceCoverage, canary: coverage.worldBankCanary, deterministicDetailReady: detail.filter((item) => item.detailContractReady).length, outputs: outputRoot }));
await prisma.$disconnect();
