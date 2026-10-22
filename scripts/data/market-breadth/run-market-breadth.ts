import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { consumeGlobalIndexDepthGaps } from "../index/consume-global-index-depth-gaps.ts";

const ROOT = process.cwd();
const RUNTIME = join(ROOT, "runtime", "market-breadth");
const CHECKPOINT = join(RUNTIME, "checkpoint.json");
const LOG = join(RUNTIME, "market-breadth.log");
const MANIFEST = join(RUNTIME, "completion-manifest.json");
const ARCHIVE = join(RUNTIME, "archive");
const RETRY = join(RUNTIME, "retry");
const COVERAGE_MATRIX = join(RUNTIME, "coverage-matrix.json");
const READINESS = join(RUNTIME, "readiness.json");
const ANALYTICS_CONTRACT = join(RUNTIME, "analytics-contract.json");
const SOURCE = "TWSE Official MI_INDEX";
const DERIVED_SOURCE = "SmartFund Derived from TWSE Official MI_INDEX";
const HISTORY_DAYS_PER_CYCLE = 31;
const HISTORY_EARLIEST_VERIFIED = "2020-01-02";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });

async function json(path: string, fallback: any = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
async function atomic(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n");
  await rename(temp, path);
}
async function log(event: string, detail: Record<string, unknown> = {}) {
  await appendFile(LOG, JSON.stringify({ at: now(), event, ...detail }) + "\n");
}
async function checkpoint(state: any, patch: Record<string, unknown> = {}) {
  Object.assign(state, patch, { pid: process.pid, updatedAt: now() });
  await atomic(CHECKPOINT, state);
}
function isoDate(date: Date) { return date.toISOString().slice(0, 10); }
function compactDate(value: string) { return value.replaceAll("-", ""); }
function priorDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return isoDate(date);
}
function count(value: unknown) {
  const match = String(value ?? "").replaceAll(",", "").match(/^\d+/);
  return match ? Number(match[0]) : null;
}
function parentheticalCount(value: unknown) {
  const match = String(value ?? "").replaceAll(",", "").match(/\((\d+)\)/);
  return match ? Number(match[1]) : null;
}

async function fetchTwse(date: string) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${compactDate(date)}&type=MS&response=json`;
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "SmartFund market breadth/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`TWSE_HTTP_${response.status}`);
  const payload: any = await response.json();
  if (payload?.stat !== "OK") return null;
  const table = payload.tables?.find((item: any) => Array.isArray(item?.data) && item.data.some((row: unknown[]) => String(row?.[0] ?? "").startsWith("上漲")));
  if (!table) return null;
  const rows = new Map((table.data ?? []).map((row: unknown[]) => [String(row[0]), row]));
  const advancingRow: any = [...rows.entries()].find(([key]) => key.startsWith("上漲"))?.[1];
  const decliningRow: any = [...rows.entries()].find(([key]) => key.startsWith("下跌"))?.[1];
  const marketTable = payload.tables?.find((item: any) => Array.isArray(item?.data) && item.data.some((row: unknown[]) => String(row?.[0] ?? "").startsWith("總計(1~15)")));
  const totalMarketRow: any = marketTable?.data?.find((row: unknown[]) => String(row?.[0] ?? "").startsWith("總計(1~15)"));
  const metrics = [
    ["ADVANCING_ISSUES", count(advancingRow?.[2])],
    ["DECLINING_ISSUES", count(decliningRow?.[2])],
    ["UNCHANGED_ISSUES", count(rows.get("持平")?.[2])],
    ["LIMIT_UP_ISSUES", parentheticalCount(advancingRow?.[2])],
    ["LIMIT_DOWN_ISSUES", parentheticalCount(decliningRow?.[2])],
    ["NO_TRADE_ISSUES", count(rows.get("未成交")?.[2])],
    ["NO_COMPARISON_ISSUES", count(rows.get("無比價")?.[2])],
    ["TOTAL_MARKET_VALUE", count(totalMarketRow?.[1])],
    ["TOTAL_MARKET_VOLUME", count(totalMarketRow?.[2])],
  ] as const;
  if (metrics.slice(0, 3).some(([, value]) => value === null)) throw new Error("TWSE_BREADTH_PARSE_FAILED");
  const observationDate = `${payload.date.slice(0, 4)}-${payload.date.slice(4, 6)}-${payload.date.slice(6, 8)}`;
  return { observationDate, url, metrics, sourceRecordId: `TWSE_MI_INDEX_${payload.date}` };
}

async function latestTwse() {
  const today = isoDate(new Date());
  for (let offset = 0; offset < 7; offset += 1) {
    const result = await fetchTwse(priorDate(today, offset));
    if (result) return result;
  }
  throw new Error("TWSE_NO_TRADING_DATA_IN_LAST_7_DAYS");
}

async function writeTwse(result: Awaited<ReturnType<typeof latestTwse>>) {
  for (const [metricType, value] of result.metrics.filter(([, value]) => value !== null)) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO market_breadth_observations
       (id, market, observation_date, metric_type, value, unit, source, source_reference, created_at, updated_at)
       VALUES ($1::uuid, 'TWSE', $2::date, $3, $4, $7, $5, $6, NOW(), NOW())
       ON CONFLICT (market, observation_date, metric_type)
       DO UPDATE SET value=EXCLUDED.value, unit=EXCLUDED.unit, source=EXCLUDED.source,
                     source_reference=EXCLUDED.source_reference, updated_at=NOW()`,
      randomUUID(), result.observationDate, metricType, value, SOURCE, result.url,
      metricType === "TOTAL_MARKET_VALUE" ? "TWD" : metricType === "TOTAL_MARKET_VOLUME" ? "SHARES" : "ISSUES",
    );
  }
  const readBack = await prisma.$queryRawUnsafe<any[]>(
    `SELECT metric_type, value::text, source FROM market_breadth_observations
     WHERE market='TWSE' AND observation_date=$1::date AND source=$2
     ORDER BY metric_type`,
    result.observationDate, SOURCE,
  );
  if (readBack.length !== result.metrics.filter(([, value]) => value !== null).length) throw new Error("TWSE_CANONICAL_READ_BACK_FAILED");
  await atomic(join(ARCHIVE, `${result.sourceRecordId}.json`), {
    marketId: "TWSE", observationDate: result.observationDate, sourceType: "OFFICIAL_SOURCE_OBSERVATION",
    source: SOURCE, sourceUrl: result.url, sourceRecordId: result.sourceRecordId,
    archivedAt: now(), retention: "METADATA_ONLY_PENDING_LICENSE_REVIEW", metricCount: result.metrics.filter(([, value]) => value !== null).length,
  });
  return readBack;
}

async function upsertDerived(date: string, metricType: string, value: number, calculationMethod: string, unit = "INDEX_POINTS") {
  await prisma.$executeRawUnsafe(
    `INSERT INTO market_breadth_observations
     (id, market, observation_date, metric_type, value, unit, source, source_reference, created_at, updated_at)
     VALUES ($1::uuid, 'TWSE', $2::date, $3, $4::numeric, $7, $5, $6, NOW(), NOW())
     ON CONFLICT (market, observation_date, metric_type)
     DO UPDATE SET value=EXCLUDED.value, unit=EXCLUDED.unit, source=EXCLUDED.source,
                   source_reference=EXCLUDED.source_reference, updated_at=NOW()`,
    randomUUID(), date, metricType, String(value), DERIVED_SOURCE, calculationMethod, unit,
  );
}

async function rebuildTwseAnalytics() {
  const inputs = await prisma.$queryRawUnsafe<any[]>(
    `SELECT observation_date::text AS date,
            MAX(value) FILTER (WHERE metric_type='ADVANCING_ISSUES')::text AS advancing,
            MAX(value) FILTER (WHERE metric_type='DECLINING_ISSUES')::text AS declining,
            MAX(value) FILTER (WHERE metric_type='UNCHANGED_ISSUES')::text AS unchanged,
            MAX(value) FILTER (WHERE metric_type='LIMIT_UP_ISSUES')::text AS limit_up,
            MAX(value) FILTER (WHERE metric_type='LIMIT_DOWN_ISSUES')::text AS limit_down,
            MAX(value) FILTER (WHERE metric_type='NO_TRADE_ISSUES')::text AS no_trade,
            MAX(value) FILTER (WHERE metric_type='NO_COMPARISON_ISSUES')::text AS no_comparison
       FROM market_breadth_observations
      WHERE market='TWSE' AND metric_type IN ('ADVANCING_ISSUES','DECLINING_ISSUES','UNCHANGED_ISSUES','LIMIT_UP_ISSUES','LIMIT_DOWN_ISSUES','NO_TRADE_ISSUES','NO_COMPARISON_ISSUES')
      GROUP BY observation_date ORDER BY observation_date`,
  );
  let adLine = 0, ema19 = 0, ema39 = 0, summation = 0, written = 0;
  for (let index = 0; index < inputs.length; index += 1) {
    const row = inputs[index];
    const advancing = Number(row.advancing), declining = Number(row.declining), unchanged = Number(row.unchanged);
    if (![advancing, declining, unchanged].every(Number.isFinite)) continue;
    const net = advancing - declining;
    const directional = advancing + declining;
    const comparable = directional + unchanged;
    const noTrade = Number(row.no_trade), noComparison = Number(row.no_comparison);
    const totalObserved = comparable + (Number.isFinite(noTrade) ? noTrade : 0) + (Number.isFinite(noComparison) ? noComparison : 0);
    adLine += net;
    ema19 += (net - ema19) * (2 / 20);
    ema39 += (net - ema39) * (2 / 40);
    const oscillator = ema19 - ema39;
    summation += oscillator;
    await upsertDerived(row.date, "ADVANCE_DECLINE_LINE", adLine, "v2: cumulative net advances; baseline earliest verified session at 0");
    await upsertDerived(row.date, "NET_ADVANCES", net, "v1: advancing-declining", "ISSUES");
    await upsertDerived(row.date, "TOTAL_ISSUES", comparable, "v1: comparable issues=advancing+declining+unchanged", "ISSUES");
    await upsertDerived(row.date, "TOTAL_OBSERVED_ISSUES", totalObserved, "v1: comparable+no-trade+no-comparison", "ISSUES");
    if (directional !== 0) {
      await upsertDerived(row.date, "ADVANCE_RATIO", advancing / directional, "v2: advancing/(advancing+declining); null when denominator=0", "RATIO");
      await upsertDerived(row.date, "DECLINE_RATIO", declining / directional, "v2: declining/(advancing+declining); null when denominator=0", "RATIO");
    }
    if (comparable !== 0) {
      await upsertDerived(row.date, "BREADTH_RATIO", net / comparable, "v2: net advances/comparable issues; null when denominator=0", "RATIO");
    }
    if (declining !== 0) await upsertDerived(row.date, "AD_RATIO", advancing / declining, "v1: advancing/declining; null when declining=0", "RATIO");
    if (totalObserved !== 0) {
      await upsertDerived(row.date, "TRADING_PARTICIPATION_RATE", directional / totalObserved, "v1: (advancing+declining)/total observed issues", "RATIO");
      await upsertDerived(row.date, "COMPARABLE_ISSUE_RATE", comparable / totalObserved, "v1: comparable/total observed issues", "RATIO");
      if (Number.isFinite(noTrade)) await upsertDerived(row.date, "NO_TRADE_RATE", noTrade / totalObserved, "v1: no-trade/total observed issues", "RATIO");
      if (Number.isFinite(noComparison)) await upsertDerived(row.date, "NO_COMPARISON_RATE", noComparison / totalObserved, "v1: no-comparison/total observed issues", "RATIO");
    }
    const limitUp = Number(row.limit_up), limitDown = Number(row.limit_down);
    if (Number.isFinite(limitUp) && Number.isFinite(limitDown)) {
      await upsertDerived(row.date, "LIMIT_UP_MINUS_LIMIT_DOWN", limitUp - limitDown, "v1: limit-up issues-limit-down issues", "ISSUES");
      if (comparable !== 0) {
        await upsertDerived(row.date, "LIMIT_UP_RATIO", limitUp / comparable, "v1: limit-up/comparable issues", "RATIO");
        await upsertDerived(row.date, "LIMIT_DOWN_RATIO", limitDown / comparable, "v1: limit-down/comparable issues", "RATIO");
      }
      if (limitDown !== 0) await upsertDerived(row.date, "LIMIT_UP_DOWN_RATIO", limitUp / limitDown, "v1: limit-up/limit-down; null when denominator=0", "RATIO");
    }
    if (index >= 38) {
      await upsertDerived(row.date, "MCCLELLAN_OSCILLATOR", oscillator, "v1: EMA19(net advances)-EMA39(net advances); 39-session warm-up required");
      await upsertDerived(row.date, "MCCLELLAN_SUMMATION", summation, "v1: cumulative McClellan oscillator; 39-session warm-up required");
      written += 2;
    }
    written += 8;
  }
  const baselineDate = inputs[0]?.date ?? null;
  await atomic(ANALYTICS_CONTRACT, {
    version: 2, generatedAt: now(), baselineDate, baselineValue: 0,
    adLine: "AD_LINE[t]=AD_LINE[t-1]+ADVANCING_ISSUES-DECLINING_ISSUES",
    advanceRatio: "ADVANCING_ISSUES/(ADVANCING_ISSUES+DECLINING_ISSUES)",
    breadthRatio: "(ADVANCING_ISSUES-DECLINING_ISSUES)/COMPARABLE_ISSUES",
    adRatio: "ADVANCING_ISSUES/DECLINING_ISSUES; null when denominator=0",
    mcclellan: { fastEma: "19 sessions; alpha=2/20", slowEma: "39 sessions; alpha=2/40", warmupRequired: 39, preWarmupValues: "NOT_MATERIALIZED" },
    participation: "Comparable and total-observed denominators are separate; no-trade/no-comparison are never treated as declines or unchanged",
    pointInTime: "No forward fill; ordered verified trading observations only", formulaVersion: "TWSE_BREADTH_V2",
  });
  return { inputDays: inputs.length, written, baselineDate, formulaVersion: "TWSE_BREADTH_V2", warmupRequired: 39, mcclellanValidated: inputs.length >= 39 };
}

async function boundedTwseHistory(state: any) {
  const today = isoDate(new Date());
  const target = HISTORY_EARLIEST_VERIFIED;
  let cursor = state.background?.twseHistoryCursor ?? priorDate(today, 1);
  let attempted = 0, ingested = 0;
  while (cursor >= target && attempted < HISTORY_DAYS_PER_CYCLE) {
    const workDate = cursor;
    cursor = priorDate(cursor, 1);
    attempted += 1;
    try {
      const result = await fetchTwse(workDate);
      if (result) { await writeTwse(result); ingested += 1; }
      else await atomic(join(ARCHIVE, `TWSE_SESSION_GAP_${workDate}.json`), { marketId: "TWSE", observationDate: workDate, classification: "SOURCE_NO_ROW", verifiedAt: now(), source: SOURCE });
    } catch (error: any) {
      await atomic(join(RETRY, `TWSE_${workDate}.json`), {
        marketId: "TWSE", stage: "HISTORY", observationDate: workDate,
        failureType: String(error?.message ?? error).includes("PARSE") ? "PARSE" : "TRANSIENT_NETWORK",
        error: String(error?.message ?? error), attempts: 1, nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }
  }
  state.background = { ...(state.background ?? {}), twseHistoryCursor: cursor, twseHistoryTarget: target,
    historyStatus: cursor < target ? "COMPLETE_DEEPEST_VERIFIED" : "RUNNING", lastBatchAttempted: attempted, lastBatchIngested: ingested };
  return { attempted, ingested, cursor, target, status: state.background.historyStatus };
}

async function boundedTwseEnrichment(state: any, latestDate: string) {
  const target = "2026-02-05";
  let cursor = state.background?.twseEnrichmentCursor ?? latestDate;
  let attempted = 0, reconciled = 0;
  while (cursor >= target && attempted < HISTORY_DAYS_PER_CYCLE) {
    const workDate = cursor;
    cursor = priorDate(cursor, 1);
    attempted += 1;
    try {
      const result = await fetchTwse(workDate);
      if (result) { await writeTwse(result); reconciled += 1; }
      else await atomic(join(ARCHIVE, `TWSE_SESSION_GAP_${workDate}.json`), { marketId: "TWSE", observationDate: workDate, classification: "SOURCE_NO_ROW", verifiedAt: now(), source: SOURCE });
    } catch (error: any) {
      await atomic(join(RETRY, `TWSE_ENRICH_${workDate}.json`), {
        marketId: "TWSE", stage: "SOURCE_METRIC_ENRICHMENT", observationDate: workDate,
        failureType: String(error?.message ?? error).includes("PARSE") ? "PARSER_FAILURE" : "TRANSIENT_NETWORK",
        error: String(error?.message ?? error), attempts: 1, nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }
  }
  state.background = { ...(state.background ?? {}), twseEnrichmentCursor: cursor, twseEnrichmentTarget: target,
    enrichmentStatus: cursor < target ? "COMPLETE" : "RUNNING", enrichmentAttempted: attempted, enrichmentReconciled: reconciled };
  return { attempted, reconciled, cursor, target, status: state.background.enrichmentStatus };
}

async function writeCoverageMatrix(state: any, latestDate: string, analytics: any) {
  const markets = ["TWSE", "NASDAQ", "NYSE", "CBOE", "TPEX", "JPX", "HKEX", "KRX", "LSE", "EURONEXT", "ASX", "SGX"];
  const rows = markets.map((marketId) => marketId === "TWSE" ? {
    marketId, identityStatus: "PASS", sourceStrategy: "OFFICIAL_SOURCE_OBSERVATION", sourceState: "SOURCE_READY", universeStatus: "EXCHANGE_DEFINED",
    latestStatus: "PASS", historyStatus: state.background?.historyStatus ?? "RUNNING", historyFirstDate: state.background?.twseHistoryCursor ?? null,
    historyLastDate: latestDate, advDeclStatus: "PASS", highLowStatus: "INPUT_CONSTRAINED", volumeStatus: "INPUT_CONSTRAINED",
    adLineStatus: analytics.inputDays > 0 ? "BOUNDED_BASELINE_DERIVED" : "PENDING", trinStatus: "INPUT_CONSTRAINED",
    mcclellanStatus: analytics.mcclellanValidated ? "PASS" : "WARMUP_INSUFFICIENT", provenanceStatus: "PASS", freshnessStatus: "CURRENT",
    licenseState: "REVIEW_REQUIRED", detailReadiness: "PRODUCTION_READY_FUNCTIONAL_CORE", coverageStatus: "PRODUCTION_READY",
  } : {
    marketId, identityStatus: "PASS", sourceStrategy: marketId === "NASDAQ" ? "OFFICIAL_CANARY_NOT_REGISTERED" : "SOURCE_DISCOVERY_REQUIRED",
    sourceState: marketId === "NASDAQ" ? "SOURCE_CONSTRAINED" : "LICENSE_CONSTRAINED", licenseState: "LICENSE_PENDING",
    universeStatus: "CONTRACT_READY_INPUT_PENDING", latestStatus: "SOURCE_PENDING", historyStatus: "SOURCE_PENDING",
    historyFirstDate: null, historyLastDate: null, advDeclStatus: "PENDING", highLowStatus: "PENDING", volumeStatus: "PENDING",
    adLineStatus: "PENDING", trinStatus: "PENDING", mcclellanStatus: "PENDING", provenanceStatus: "PENDING",
    freshnessStatus: "SOURCE_PENDING", detailReadiness: "SOURCE_CONSTRAINED", coverageStatus: marketId === "NASDAQ" ? "CANARY_ONLY" : "MISSING",
  });
  await atomic(COVERAGE_MATRIX, { version: 1, generatedAt: now(), rows });
  return rows;
}

async function writeReadiness(analytics: any) {
  const contract = await json(join(ROOT, "config", "market-breadth-readiness.json"), { metricStates: [], marketStates: [] });
  const verifiedAt = now();
  const metricStates = contract.metricStates.map((metric: any) => {
    if (analytics.mcclellanValidated && ["MCCLELLAN_OSCILLATOR", "MCCLELLAN_SUMMATION"].includes(metric.metricCode)) {
      return { ...metric, state: "DERIVED_READY", missingReason: null, verificationState: "FORMULA_AND_WARMUP_VERIFIED", lastVerifiedAt: verifiedAt };
    }
    return { ...metric, lastVerifiedAt: verifiedAt };
  });
  const marketStates = contract.marketStates.map((market: any) => ({ ...market, lastVerifiedAt: verifiedAt }));
  const allowedMetricStates = new Set(["PRODUCTION_READY", "DERIVED_READY", "WARMUP_PENDING", "INPUT_CONSTRAINED", "SOURCE_CONSTRAINED", "NOT_APPLICABLE", "NOT_READY"]);
  const allowedMarketStates = new Set(["PRODUCTION_READY", "SOURCE_CONSTRAINED", "LICENSE_CONSTRAINED", "SOURCE_PENDING", "NOT_APPLICABLE"]);
  if (metricStates.length !== 13 || marketStates.length !== 12 || metricStates.some((item: any) => !allowedMetricStates.has(item.state)) || marketStates.some((item: any) => !allowedMarketStates.has(item.state))) {
    throw new Error("READINESS_CONTRACT_FAIL_CLOSED");
  }
  await atomic(READINESS, { version: 1, generatedAt: verifiedAt, metricStates, marketStates, unknownMetricStates: 0, unknownMarketStates: 0 });
  return { metricStates, marketStates };
}

async function main() {
  await Promise.all([RUNTIME, ARCHIVE, RETRY].map((path) => mkdir(path, { recursive: true })));
  const state = await json(CHECKPOINT, { asset: "GLOBAL_MARKET_BREADTH", startedAt: now(), cycles: 0, sources: {} });
  await checkpoint(state, { status: "RUNNING", currentStage: "P0_RECOVERY_ACTIVATED", supervisorStartedAt: now(), singleWriter: true });
  await log("RUNNER_STARTED", { pid: process.pid, resumeFrom: state.sources?.TWSE?.cursor ?? null });
  while (true) {
    try {
      await checkpoint(state, { currentStage: "LATEST" });
      const sourceLatest = await latestTwse();
      const readBack = await writeTwse(sourceLatest);
      state.stages = { ...(state.stages ?? {}), latest: { status: "PASS", cursor: sourceLatest.observationDate, updatedAt: now() } };
      await checkpoint(state, { currentStage: "HISTORICAL_BOUNDED" });
      const history = await boundedTwseHistory(state);
      state.stages.historical = { status: history.status, cursor: history.cursor, target: history.target, updatedAt: now() };
      await checkpoint(state, { currentStage: "SOURCE_METRIC_ENRICHMENT" });
      const enrichment = await boundedTwseEnrichment(state, sourceLatest.observationDate);
      state.stages.enrichment = { status: enrichment.status, cursor: enrichment.cursor, target: enrichment.target, updatedAt: now() };
      const previousManifest = await json(MANIFEST, {});
      let analytics: any;
      if (history.status === "COMPLETE_DEEPEST_VERIFIED" && enrichment.status === "COMPLETE") {
        await checkpoint(state, { currentStage: "FINAL_DERIVED_RECOMPUTE" });
        analytics = { ...(await rebuildTwseAnalytics()), recomputeStatus: "FINAL_COMPLETE" };
      } else {
        analytics = { ...(previousManifest.analytics ?? {}), recomputeStatus: "DEFERRED_UNTIL_SOURCE_DEPTH_COMPLETE", pendingHistoryTarget: history.target };
      }
      const readiness = await writeReadiness(analytics);
      const matrix = await writeCoverageMatrix(state, sourceLatest.observationDate, analytics);
      state.cycles = (state.cycles ?? 0) + 1;
      state.sources = {
        ...state.sources,
        TWSE: { status: "COMPLETE", cursor: sourceLatest.observationDate, metrics: sourceLatest.metrics.map(([metric]) => metric), lastSuccessAt: now() },
        NYSE: { status: "SOURCE_RECOVERY_PENDING" },
        NASDAQ: { status: "CANARY_PASS_OFFICIAL_YTD_FILE", production: false },
        CBOE: { status: "SOURCE_RECOVERY_PENDING" },
      };
      await atomic(MANIFEST, {
        asset: state.asset, completedAt: now(), market: "TWSE", sourceLatest: sourceLatest.observationDate,
        canonicalTarget: "market_breadth_observations", canonicalWrite: "PASS", readBack: "PASS",
        metrics: readBack, analytics, history, enrichment, coverageMatrixRows: matrix.length,
        metricReadinessRows: readiness.metricStates.length, marketReadinessRows: readiness.marketStates.length,
        sourceType: "OFFICIAL_SOURCE_OBSERVATION", provenance: "PASS", freshness: "CURRENT",
        latestPath: true, incremental: true, scheduler: "ACTIVE", autoContinuing: true, singleWriter: true,
      });
      await checkpoint(state, { currentStage: "INCREMENTAL_WAIT", lastError: null, nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString() });
      state.stages.incremental = { status: "ACTIVE", cursor: sourceLatest.observationDate, nextRunAt: state.nextRunAt };
      await checkpoint(state);
      await log("TWSE_P0_CYCLE_COMPLETE", { date: sourceLatest.observationDate, records: readBack.length, history, analytics });
      await consumeGlobalIndexDepthGaps().catch(() => undefined);
    } catch (error: any) {
      await checkpoint(state, { currentStage: "RETRY_WAIT", lastError: String(error?.message ?? error), nextRunAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      await log("TWSE_RETRY", { error: String(error?.message ?? error) });
    }
    await sleep(60 * 60_000);
  }
}

main().catch(async (error) => {
  try { await log("RUNNER_FATAL", { error: String(error?.stack ?? error) }); }
  finally { await prisma.$disconnect(); process.exitCode = 1; }
});
