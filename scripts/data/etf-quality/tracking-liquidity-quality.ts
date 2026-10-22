import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";

const DIR = resolve(process.cwd(), "runtime", "etf-quality");
const day = (value: Date) => value.toISOString().slice(0, 10);
const n = (value: unknown) => Number(value);
async function atomicJson(file: string, value: unknown) { await mkdir(DIR, { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n"); await rename(temporary, file); }
function returns(rows: Array<{ date: Date; close: unknown }>) { const sorted = [...rows].sort((a, b) => a.date.getTime() - b.date.getTime()); const values = new Map<string, number>(); for (let i = 1; i < sorted.length; i++) { const prior = n(sorted[i - 1].close), current = n(sorted[i].close); if (prior > 0 && current > 0) values.set(day(sorted[i].date), current / prior - 1); } return values; }
function sampleStd(values: number[]) { if (values.length < 2) return null; const mean = values.reduce((a, b) => a + b, 0) / values.length; return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)); }

export async function materializeTrackingLiquidityQuality(prisma: PrismaClient, code = "IVV") {
  const etfs = await prisma.$queryRawUnsafe<Array<any>>("SELECT id,code,benchmark,currency FROM etfs WHERE UPPER(code)=UPPER($1) LIMIT 1", code);
  if (!etfs[0]) throw new Error(`ETF_NOT_FOUND:${code}`); const etf = etfs[0];
  const indexes = etf.benchmark ? await prisma.$queryRawUnsafe<Array<any>>(
    "SELECT id,code,name,provider FROM market_indexes WHERE is_active=true AND regexp_replace(lower(name),'[^a-z0-9]','','g')=regexp_replace(lower(regexp_replace($1,' index$','','i')),'[^a-z0-9]','','g') LIMIT 2", etf.benchmark,
  ) : [];
  const benchmark = indexes.length === 1 ? indexes[0] : null;
  const market = await prisma.$queryRawUnsafe<Array<any>>("SELECT date,close,volume FROM (SELECT date,price close,volume,0 priority FROM etf_history WHERE etf_id=$1 AND price>0 UNION ALL SELECT date,close,volume,1 priority FROM market_history WHERE UPPER(symbol)=UPPER($2) AND close>0) x ORDER BY date DESC,priority LIMIT 260", etf.id, code);
  const indexRows = benchmark ? await prisma.$queryRawUnsafe<Array<any>>("SELECT date,close FROM index_history WHERE index_id=$1 AND close>0 ORDER BY date DESC LIMIT 260", benchmark.id) : [];
  const navRows = await prisma.$queryRawUnsafe<Array<any>>("SELECT DISTINCT ON (observation_date) observation_date,nav,aum,currency,source,retrieved_at,verification_status FROM etf_asset_metrics WHERE etf_id=$1 AND nav>0 AND aum>0 AND verification_status IN ('VERIFIED_OFFICIAL','VERIFIED_DERIVED') ORDER BY observation_date DESC,updated_at DESC LIMIT 260", etf.id);
  const now = new Date().toISOString();
  const assignment = { scope: "FULL_ELIGIBLE_ETF_UNIVERSE", history: "FULL_COMPATIBLE_VERIFIED_HISTORY", lifecycle: "EXISTING_GLOBAL_ETF_FLOWS_ORDINARY_NODE_LIFECYCLE", maxDbConcurrency: 1, trackingGate: "UNIQUE_CANONICAL_BENCHMARK_MAPPING_PLUS_COMPATIBLE_PRICE_RETURN_DATES", liquidityRules: { bidAsk: "REPORTED_VERIFIED_QUOTES_ONLY", volume: "VERIFIED_MARKET_VOLUME", turnover: "PRICE_X_VOLUME_DIVIDED_BY_AUM", aum: "VERIFIED_REPORTED_OR_DERIVED_AUM" }, replicationQuality: { composite: "DISABLED_UNTIL_ALL_REQUIRED_COMPONENTS_AND_WEIGHTS_ARE_EXPLICIT", componentsStoredSeparately: true }, state: "ACTIVE_AUTO_CONTINUING", updatedAt: now };
  await atomicJson(resolve(DIR, "ordinary-worker-assignment.json"), assignment);
  const navMap = new Map(navRows.map(row => [day(new Date(row.observation_date)), row]));
  const joint = market.flatMap(row => { const nav = navMap.get(day(new Date(row.date))); return nav ? [{ date: new Date(row.date), close: n(row.close), volume: row.volume == null ? null : n(row.volume), nav: n(nav.nav), aum: n(nav.aum), source: nav.source, retrievedAt: nav.retrieved_at }] : []; }).sort((a, b) => b.date.getTime() - a.date.getTime());
  if (!joint.length) throw new Error("INPUT_GATED_NO_DATE_ALIGNED_NAV_MARKET_AUM");
  const etfReturns = returns(market), benchmarkReturns = returns(indexRows); const alignedDates = [...etfReturns.keys()].filter(date => benchmarkReturns.has(date)).sort();
  const activeReturns = alignedDates.map(date => etfReturns.get(date)! - benchmarkReturns.get(date)!); const trackingReady = Boolean(benchmark && activeReturns.length >= 20);
  const latest = joint[0]; const premiums = joint.map(row => (row.close / row.nav - 1) * 100); const premium = premiums[0]; const percentile = premiums.filter(value => value <= premium).length / premiums.length * 100;
  const trackingDifference = trackingReady ? activeReturns.reduce((a, b) => a + b, 0) / activeReturns.length * 252 * 100 : null;
  const trackingError = trackingReady ? sampleStd(activeReturns)! * Math.sqrt(252) * 100 : null;
  const tradedValue = latest.volume == null ? null : latest.close * latest.volume; const turnoverLiquidity = tradedValue == null || latest.aum <= 0 ? null : tradedValue / latest.aum * 100;
  const common = { etf_id: etf.id, etf_code: etf.code, as_of: day(latest.date), currency: etf.currency, source: "EXISTING_VERIFIED_MARKET_NAV_AUM_SERIES", retrieved_at: latest.retrievedAt ? new Date(latest.retrievedAt).toISOString() : now, reported_or_derived: "SMARTFUND_DERIVED" };
  const observations = [
    { ...common, metric: "TRACKING_DIFFERENCE", value: trackingDifference, input_state: trackingReady ? "VERIFIED" : "INPUT_GATED", benchmark: benchmark?.name ?? etf.benchmark, methodology: "ANNUALIZED_MEAN_DAILY_ETF_PRICE_RETURN_MINUS_BENCHMARK_PRICE_RETURN;252" },
    { ...common, metric: "TRACKING_ERROR", value: trackingError, input_state: trackingReady ? "VERIFIED" : "INPUT_GATED", benchmark: benchmark?.name ?? etf.benchmark, methodology: "SAMPLE_STDDEV_DAILY_ACTIVE_PRICE_RETURN_X_SQRT_252" },
    { ...common, metric: "PREMIUM_DISCOUNT", value: premium, methodology: "(MARKET_CLOSE/NAV-1)*100" },
    { ...common, metric: "PREMIUM_DISCOUNT_PERCENTILE", value: percentile, sample_count: premiums.length, methodology: "EMPIRICAL_PERCENTILE_WITHIN_DATE_ALIGNED_HISTORY" },
    { ...common, metric: "VOLUME_LIQUIDITY", value: latest.volume, reported_or_derived: "REPORTED_MARKET_INPUT", methodology: "REPORTED_DAILY_VOLUME;NO_BID_ASK_INFERENCE" },
    { ...common, metric: "TURNOVER_LIQUIDITY", value: turnoverLiquidity, components: { close: latest.close, volume: latest.volume, aum: latest.aum, traded_value: tradedValue }, methodology: "CLOSE_X_VOLUME_DIVIDED_BY_AUM_X100" },
  ].filter(row => row.value != null);
  const artifactFile = resolve(DIR, "canary-observations.json"); await atomicJson(artifactFile, { asset: "ETF", canaryEtf: code, benchmark: benchmark?.name ?? etf.benchmark, observations, generatedAt: now });
  const readback = JSON.parse(await readFile(artifactFile, "utf8")); if (!readback.observations?.length || readback.observations.length > 6 || readback.observations.some((row: any) => row.value == null)) throw new Error("ETF_QUALITY_READBACK_FAILED");
  const checkpoint = { asset: "ETF", canaryEtf: code, benchmark: benchmark?.name ?? etf.benchmark, benchmarkMappingState: benchmark ? "VERIFIED_UNIQUE_CANONICAL_MATCH" : "INPUT_GATED_AUTO_CONTINUING", state: "ACTIVE_AUTO_CONTINUING", checkpoint: day(latest.date), observationsPersisted: observations.length, readback: "PASS", trackingDifferenceStatus: trackingReady ? "ACTIVE" : "INPUT_GATED_AUTO_CONTINUING", trackingErrorStatus: trackingReady ? "ACTIVE" : "INPUT_GATED_AUTO_CONTINUING", premiumDiscountStatus: "ACTIVE", liquidityStatus: turnoverLiquidity == null ? "PARTIAL_INPUT_GATED" : "ACTIVE_WITHOUT_BID_ASK", replicationQualityStatus: "COMPONENTS_ACTIVE_COMPOSITE_INPUT_GATED", missingInputs: [!benchmark ? "VERIFIED_BENCHMARK_MAPPING" : null, !trackingReady ? "COMPATIBLE_BENCHMARK_RETURN_HISTORY_MIN_20" : null, "VERIFIED_BID_ASK", "VERIFIED_SECURITIES_LENDING", "VERIFIED_TAX_DRAG"].filter(Boolean), assignment, updatedAt: now };
  await atomicJson(resolve(DIR, "checkpoint.json"), checkpoint); return checkpoint;
}
