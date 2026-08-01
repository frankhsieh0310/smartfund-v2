import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { productionProviderRegistry } from "../../../lib/data-platform/providers/ProviderRegistry.ts";
import type { ProviderAssetClass, ProviderPoint } from "../../../lib/data-platform/providers/ProviderAdapter.ts";
import {
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  heartbeatLifecycleLock,
  loadLifecycleResumeCheckpoint,
  persistLifecycleCheckpoint,
  recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
} from "../production/run-lifecycle.ts";

type AssetKind = "GLOBAL_ETF" | "BOND_YIELD" | "MARKET_INDEX" | "VOLATILITY" | "COMMODITY" | "FX" | "CRYPTO";
type Item = { id: string; symbol: string; name: string; currency: string | null; latestDate: Date | null };

const prisma = new PrismaClient();
const CONCURRENCY = 4;
const CHECKPOINT_EVERY = 25;
// Four requests at a time keeps Yahoo within the established rate limit while
// finishing a 12k ETF universe in bounded, resumable production slices.
const MAX_PER_CRON = 200;
const requested = process.argv.find((value) => value.startsWith("--job="))?.slice(6) as AssetKind | undefined;
const force = process.argv.includes("--force");
const primaryKinds: AssetKind[] = ["GLOBAL_ETF", "BOND_YIELD", "MARKET_INDEX", "VOLATILITY"];
const completionKinds: AssetKind[] = ["COMMODITY", "FX", "CRYPTO"];

function jobId(kind: AssetKind): string { return `${kind.toLowerCase()}-production-daily`; }
function exchange(kind: AssetKind): string { return kind; }
function day(value: Date | null | undefined): string | null { return value ? value.toISOString().slice(0, 10) : null; }
function isCurrent(databaseLatest: Date | null, providerLatest: Date | null): boolean {
  return Boolean(providerLatest && databaseLatest && day(databaseLatest)! >= day(providerLatest)!);
}

function newYorkDay(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function completedToday(job: string, retryCompletedFailures = false): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ started_at: Date; failed: number }[]>("SELECT started_at, failed FROM production_scheduler_runs WHERE job_id = $1 AND run_type = 'PRIMARY' AND status = 'COMPLETED' ORDER BY started_at DESC LIMIT 1", job);
  return Boolean(rows[0] && newYorkDay(rows[0].started_at) === newYorkDay() && (!retryCompletedFailures || rows[0].failed === 0));
}

function providerAssetClass(kind: AssetKind): ProviderAssetClass {
  return kind === "GLOBAL_ETF" ? "ETF" : kind === "MARKET_INDEX" ? "MARKET_INDEX" : kind;
}

function marketType(kind: AssetKind): "BOND" | "INDEX" | "VOLATILITY" | "COMMODITY" | "FOREX" | "CRYPTO" {
  if (kind === "BOND_YIELD") return "BOND";
  if (kind === "MARKET_INDEX") return "INDEX";
  if (kind === "FX") return "FOREX";
  if (kind === "GLOBAL_ETF") throw new Error("ETF_DOES_NOT_USE_MARKET_TYPE");
  return kind;
}

function usesCanonicalMarketData(kind: AssetKind): boolean {
  return kind === "COMMODITY" || kind === "FX" || kind === "CRYPTO";
}

type ProviderConfig = { providerAdapter?: string; instrumentMappings?: Record<string, string> };
async function configuredProvider(assetClass: ProviderAssetClass): Promise<ProviderConfig> {
  const config = JSON.parse(await readFile(join(process.cwd(), "config", "asset-provider-registry.json"), "utf8")) as { assets: Record<string, ProviderConfig> };
  const provider = config.assets[assetClass];
  if (!provider?.providerAdapter) throw new Error(`PROVIDER_MAPPING_NOT_CONFIGURED:${assetClass}`);
  return provider;
}

async function universe(kind: AssetKind): Promise<Item[]> {
  if (kind === "GLOBAL_ETF") {
    return prisma.$queryRawUnsafe<Item[]>("SELECT e.id, e.code AS symbol, e.name, e.currency, MAX(h.date) AS \"latestDate\" FROM etfs e JOIN etf_history h ON h.etf_id = e.id WHERE e.is_active = TRUE AND NOT (COALESCE(e.exchange, '') ILIKE '%TW%' OR e.currency = 'TWD') GROUP BY e.id, e.code, e.name, e.currency ORDER BY e.code");
  }
  const type = marketType(kind);
  if (usesCanonicalMarketData(kind)) {
    return prisma.$queryRawUnsafe<Item[]>("SELECT m.id,m.symbol,m.name,m.currency,(SELECT MAX(d.date) FROM market_data d WHERE d.symbol=m.symbol) AS \"latestDate\" FROM market_master m WHERE m.is_active=TRUE AND m.asset_type::text=$1 ORDER BY m.symbol", type);
  }
  return prisma.$queryRawUnsafe<Item[]>("SELECT m.id,m.symbol,m.name,m.currency,MAX(h.date) AS \"latestDate\" FROM market_master m JOIN market_history h ON h.symbol=m.symbol WHERE m.is_active=TRUE AND m.asset_type::text=$1 GROUP BY m.id,m.symbol,m.name,m.currency ORDER BY m.symbol", type);
}

async function latestStoredDate(kind: AssetKind): Promise<Date | null> {
  const rows = kind === "GLOBAL_ETF"
    ? await prisma.$queryRawUnsafe<{ latest: Date | null }[]>("SELECT MAX(h.date) AS latest FROM etf_history h JOIN etfs e ON e.id = h.etf_id WHERE e.is_active = TRUE AND NOT (COALESCE(e.exchange, '') ILIKE '%TW%' OR e.currency = 'TWD')")
    : usesCanonicalMarketData(kind)
      ? await prisma.$queryRawUnsafe<{ latest: Date | null }[]>("SELECT MAX(d.date) AS latest FROM market_data d JOIN market_master m ON m.symbol=d.symbol WHERE m.is_active=TRUE AND m.asset_type::text=$1", marketType(kind))
      : await prisma.$queryRawUnsafe<{ latest: Date | null }[]>("SELECT MAX(h.date) AS latest FROM market_history h JOIN market_master m ON m.symbol=h.symbol WHERE m.is_active=TRUE AND m.asset_type::text=$1", marketType(kind));
  return rows[0]?.latest ?? null;
}

async function upsert(kind: AssetKind, item: Item, candle: ProviderPoint): Promise<boolean> {
  if (kind === "GLOBAL_ETF") {
    const existing = await prisma.$queryRawUnsafe<{ exists: boolean }[]>("SELECT EXISTS(SELECT 1 FROM etf_history WHERE etf_id = $1 AND date = $2::date) AS exists", item.id, candle.date.toISOString().slice(0, 10));
    await prisma.$executeRawUnsafe("INSERT INTO etf_history (id, etf_id, date, price, volume) VALUES ($1, $2, $3::date, $4, $5) ON CONFLICT (etf_id, date) DO UPDATE SET price = EXCLUDED.price, volume = EXCLUDED.volume", randomUUID(), item.id, candle.date.toISOString().slice(0, 10), candle.close, candle.volume);
    await prisma.$executeRawUnsafe("UPDATE etfs SET latest_price = $2, volume = $3, price_updated_at = NOW(), updated_at = NOW() WHERE id = $1", item.id, candle.close, candle.volume);
    return existing[0]?.exists ?? false;
  }
  if (usesCanonicalMarketData(kind)) {
    const type = marketType(kind);
    const tradeDate = candle.date.toISOString().slice(0, 10);
    const existing = await prisma.$queryRawUnsafe<{ exists: boolean }[]>("SELECT EXISTS(SELECT 1 FROM market_data WHERE symbol=$1 AND date=$2::date) AS exists", item.symbol, tradeDate);
    await prisma.$executeRawUnsafe(
      `INSERT INTO market_data (id,symbol,name,type,date,close,open,high,low,volume,currency,source)
       VALUES ($1,$2,$3,$4::"MarketType",$5::date,$6,$7,$8,$9,$10,$11,'YAHOO_CHART')
       ON CONFLICT (symbol,date) DO UPDATE SET close=EXCLUDED.close,open=EXCLUDED.open,high=EXCLUDED.high,
         low=EXCLUDED.low,volume=EXCLUDED.volume,currency=COALESCE(EXCLUDED.currency,market_data.currency),source='YAHOO_CHART'`,
      randomUUID(), item.symbol, item.name, type, tradeDate, candle.close, candle.open, candle.high, candle.low, candle.volume, item.currency,
    );
    await prisma.$executeRawUnsafe(
      "INSERT INTO market_history (id,symbol,date,open,high,low,close,volume) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8) ON CONFLICT (symbol,date) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume",
      randomUUID(), item.symbol, tradeDate, candle.open, candle.high, candle.low, candle.close, candle.volume,
    );
    await prisma.$executeRawUnsafe("UPDATE market_master SET latest_close=$2,latest_date=$3::date,updated_at=NOW() WHERE id=$1", item.id, candle.close, tradeDate);
    return existing[0]?.exists ?? false;
  }
  const existing = await prisma.$queryRawUnsafe<{ exists: boolean }[]>("SELECT EXISTS(SELECT 1 FROM market_history WHERE symbol = $1 AND date = $2::date) AS exists", item.symbol, candle.date.toISOString().slice(0, 10));
  await prisma.$executeRawUnsafe("INSERT INTO market_history (id, symbol, date, open, high, low, close, volume) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8) ON CONFLICT (symbol, date) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume", randomUUID(), item.symbol, candle.date.toISOString().slice(0, 10), candle.open, candle.high, candle.low, candle.close, candle.volume);
  await prisma.$executeRawUnsafe("UPDATE market_master SET latest_close = $2, latest_date = $3::date, updated_at = NOW() WHERE id = $1", item.id, candle.close, candle.date.toISOString().slice(0, 10));
  return existing[0]?.exists ?? false;
}

function classification(error: unknown): "PERMANENT_UNAVAILABLE" | "RETRYABLE_FAILURE" {
  const message = error instanceof Error ? error.message : String(error);
  return /YAHOO_HTTP_(404|422)|YAHOO_NO_DATA/.test(message) ? "PERMANENT_UNAVAILABLE" : "RETRYABLE_FAILURE";
}

async function recordFailure(job: string, item: Item, error: unknown): Promise<"PERMANENT_UNAVAILABLE" | "RETRYABLE_FAILURE"> {
  const kind = classification(error);
  const message = error instanceof Error ? error.message : String(error);
  await prisma.$executeRawUnsafe("INSERT INTO production_scheduler_failures (job_id, stock_id, symbol, attempts, last_error, error_type, last_attempted_at, next_retry_at, classification, resolved, resolution_reason) VALUES ($1, $2, $3, 1, $4, $5, NOW(), CASE WHEN $6 = 'RETRYABLE_FAILURE' THEN NOW() + INTERVAL '15 minutes' ELSE NULL END, $6, $6 = 'PERMANENT_UNAVAILABLE', CASE WHEN $6 = 'PERMANENT_UNAVAILABLE' THEN $4 ELSE NULL END) ON CONFLICT (job_id, stock_id) DO UPDATE SET attempts = production_scheduler_failures.attempts + 1, last_error = EXCLUDED.last_error, error_type = EXCLUDED.error_type, last_attempted_at = NOW(), next_retry_at = EXCLUDED.next_retry_at, classification = EXCLUDED.classification, resolved = EXCLUDED.resolved, resolution_reason = EXCLUDED.resolution_reason", job, item.id, item.symbol, message, message.includes("AbortError") ? "YAHOO_TIMEOUT" : "YAHOO_HTTP_ERROR", kind);
  return kind;
}

async function dueRetryItems(job: string, all: Item[]): Promise<Item[]> {
  const rows = await prisma.$queryRawUnsafe<{ stock_id: string }[]>(
    "SELECT stock_id FROM production_scheduler_failures WHERE job_id = $1 AND resolved = FALSE AND classification = 'RETRYABLE_FAILURE' AND (next_retry_at IS NULL OR next_retry_at <= NOW()) ORDER BY last_attempted_at ASC LIMIT $2",
    job,
    MAX_PER_CRON,
  );
  const ids = new Set(rows.map((row) => row.stock_id));
  return all.filter((item) => ids.has(item.id));
}

async function processItem(
  kind: AssetKind,
  job: string,
  item: Item,
  adapter: ReturnType<typeof productionProviderRegistry.get>,
  providerConfig: ProviderConfig,
): Promise<Partial<ReturnType<typeof createSummary>>> {
  try {
    const sourceSymbol = providerConfig.instrumentMappings?.[item.symbol] ?? item.symbol;
    const request = { assetClass: providerAssetClass(kind), instrument: { id: item.id, symbol: sourceSymbol, latestDate: item.latestDate } } as const;
    const providerLatest = await adapter.latestAvailableDate(request);
    if (isCurrent(item.latestDate, providerLatest)) {
      await prisma.$executeRawUnsafe("DELETE FROM production_scheduler_failures WHERE job_id = $1 AND stock_id = $2", job, item.id);
      return { attempted: 1, completed: 1, noUpdate: 1, upToProviderLatest: 1 };
    }
    const candles = await adapter.fetchLatest(request);
    const newest = candles.at(-1);
    const normalized = newest && (newest.close ?? newest.value) != null ? { ...newest, close: newest.close ?? newest.value } : null;
    if (!normalized) throw new Error("PROVIDER_NO_DATA");
    const existed = await upsert(kind, item, normalized);
    await prisma.$executeRawUnsafe("DELETE FROM production_scheduler_failures WHERE job_id = $1 AND stock_id = $2", job, item.id);
    return { attempted: 1, completed: 1, success: existed ? 0 : 1, noUpdate: existed ? 1 : 0, inserted: existed ? 0 : 1, updated: existed ? 1 : 0, upToProviderLatest: providerLatest && day(normalized.date) >= day(providerLatest) ? 1 : 0 };
  } catch (error) {
    const result = await recordFailure(job, item, error);
    return { attempted: 1, failed: 1, permanentUnavailable: result === "PERMANENT_UNAVAILABLE" ? 1 : 0, retryableFailure: result === "RETRYABLE_FAILURE" ? 1 : 0 };
  }
}

async function run(kind: AssetKind): Promise<Record<string, unknown>> {
  const job = jobId(kind);
  await recoverOrphanedLifecycleRun(prisma, job);
  if (!force && await completedToday(job, completionKinds.includes(kind))) return { job, status: "SKIPPED_COMPLETED" };
  const owner = `asset-daily:${process.env.RAILWAY_DEPLOYMENT_ID ?? process.pid}:${kind}`;
  if (!await acquireLifecycleLock(prisma, job, owner)) return { job, status: "SKIPPED_LOCKED" };
  let runId = "";
  try {
    const providerConfig = await configuredProvider(providerAssetClass(kind));
    const adapter = productionProviderRegistry.get(providerConfig.providerAdapter!);
    if (!adapter.supportedAssetClasses.includes(providerAssetClass(kind))) throw new Error(`PROVIDER_UNSUPPORTED_ASSET_CLASS:${kind}`);
    runId = await createLifecycleRun(prisma, job, exchange(kind), "PRIMARY");
    const all = await universe(kind);
    const summary = createSummary();
    const resume = await loadLifecycleResumeCheckpoint(prisma, job);
    const resumeIndex = resume?.last_symbol ? all.findIndex((item) => item.symbol === resume.last_symbol) : -1;
    if (resume?.last_symbol && resumeIndex < 0) throw new Error(`RESUME_SYMBOL_NOT_IN_UNIVERSE:${resume.last_symbol}`);
    if (resume) Object.assign(summary, resume.details ?? { attempted: resume.processed, completed: resume.succeeded, failed: resume.failed });
    const selected = (resume ? all.slice(resumeIndex + 1) : all).slice(0, MAX_PER_CRON);
    for (let offset = 0; offset < selected.length; offset += CONCURRENCY) {
      const batch = selected.slice(offset, offset + CONCURRENCY);
      const outcomes = await Promise.all(batch.map((item) => processItem(kind, job, item, adapter, providerConfig)));
      outcomes.forEach((outcome) => Object.entries(outcome).forEach(([key, value]) => { (summary as Record<string, number>)[key] = ((summary as Record<string, number>)[key] ?? 0) + (value ?? 0); }));
      if (summary.attempted % CHECKPOINT_EVERY === 0 || offset + batch.length === selected.length) {
        await persistLifecycleCheckpoint(prisma, runId, summary, batch.at(-1)!.symbol);
        await heartbeatLifecycleLock(prisma, job, owner);
      }
    }
    const remaining = all.length - summary.attempted;
    if (remaining > 0) {
      await prisma.$executeRawUnsafe("UPDATE production_scheduler_runs SET status = 'PAUSED', completed_at = NOW(), exit_code = 0 WHERE id = $1", runId);
      return { job, status: "PAUSED", processed: summary.attempted, remaining, lastSymbol: selected.at(-1)?.symbol ?? null };
    }

    // Main-universe progress is durable. Once it reaches the end, retry only
    // due transient failures without moving the main checkpoint backwards.
    const retries = await dueRetryItems(job, all);
    for (let offset = 0; offset < retries.length; offset += CONCURRENCY) {
      const batch = retries.slice(offset, offset + CONCURRENCY);
      const outcomes = await Promise.all(batch.map(async (item) => {
        const outcome = await processItem(kind, job, item, adapter, providerConfig);
        return { ...outcome, attempted: 0, completed: (outcome.completed ?? 0), failed: (outcome.failed ?? 0) - 1, retryableFailure: (outcome.retryableFailure ?? 0) - 1 };
      }));
      outcomes.forEach((outcome) => Object.entries(outcome).forEach(([key, value]) => { (summary as Record<string, number>)[key] = ((summary as Record<string, number>)[key] ?? 0) + (value ?? 0); }));
      await persistLifecycleCheckpoint(prisma, runId, summary, resume?.last_symbol ?? selected.at(-1)?.symbol ?? all.at(-1)!.symbol);
      await heartbeatLifecycleLock(prisma, job, owner);
    }

    const coverage = all.length === 0 ? 1 : (summary.success + summary.noUpdate + summary.permanentUnavailable) / all.length;
    const latestTradingDate = await latestStoredDate(kind);
    const validation = {
      status: summary.attempted === all.length && summary.attempted === summary.completed + summary.failed && coverage >= 0.98 ? "PASS" : "FAIL",
      assetClass: kind,
      universe: all.length,
      processed: summary.attempted,
      coverage,
      retryCount: retries.length,
      latestTradingDate: latestTradingDate?.toISOString().slice(0, 10) ?? null,
      freshness: { policy: "PROVIDER_LATEST_AVAILABLE", upToProviderLatest: summary.upToProviderLatest, databaseLatest: latestTradingDate?.toISOString().slice(0, 10) ?? null },
      source: adapter.source(),
      summaryType: "DAILY_SUMMARY",
    };
    await completeLifecycleRun(prisma, runId, summary, latestTradingDate, validation);
    return { job, status: validation.status, ...summary };
  } catch (error) { if (runId) await failLifecycleRun(prisma, runId, error); throw error; }
  finally { await releaseLifecycleLock(prisma, job, owner); }
}

async function main(): Promise<void> {
  if (requested) {
    console.log(JSON.stringify({ results: [await run(requested)] }, null, 2));
    return;
  }
  const runIsolated = async (kind: AssetKind): Promise<Record<string, unknown>> => {
    try { return await run(kind); }
    catch (error) {
      return {
        job: jobId(kind),
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const results = await Promise.all(primaryKinds.map(runIsolated));
  for (const kind of completionKinds) results.push(await runIsolated(kind));
  console.log(JSON.stringify({ results }, null, 2));
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
