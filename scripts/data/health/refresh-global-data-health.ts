import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { DATASETS, type DatasetDefinition } from "./dataset-registry.ts";
import { alertSeverity, evaluateAlertConditions, evaluateHealth, type CoverageEvidence, type PreviousCoverage, type RuntimeEvidence } from "./health-evaluator.ts";
import { ADAPTER_KEYS, readDatasetCoverage } from "./coverage-adapters.ts";

type Row = Record<string, unknown>;
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const now = new Date();
const dryRun = process.argv.includes("--dry-run");
const trace = process.argv.includes("--trace");
const selectedAsset = process.argv.find((value) => value.startsWith("--asset="))?.slice(8).toUpperCase();
const selectedDataset = process.argv.find((value) => value.startsWith("--dataset="))?.slice(10).toUpperCase();

function integer(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function date(value: unknown): Date | null { if (!value) return null; const parsed = new Date(String(value)); return Number.isNaN(parsed.valueOf()) ? null : parsed; }
function json(value: unknown): string { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item); }
function pct(numerator: number | null, denominator: number | null): number | null { return numerator === null || !denominator ? null : Number(((numerator / denominator) * 100).toFixed(4)); }
function runtimePath(asset: string): string {
  const names: Record<string, string> = { STOCK: "global-stock", INDEX: "global-index" };
  return `runtime-status/${names[asset] ?? asset.toLowerCase().replaceAll("_", "-")}.json`;
}
function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function one(sql: string, ...params: unknown[]): Promise<Row> { return (await prisma.$queryRawUnsafe<Row[]>(sql, ...params))[0] ?? {}; }

async function register(definition: DatasetDefinition): Promise<void> {
  if (dryRun) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO dataset_registry (dataset_key,asset_type,dataset_name,master_entity_type,target_mode,new_assets_auto_included,source_provider,update_mode,expected_frequency,freshness_policy,freshness_grace_seconds,target_universe_source,worker_name,checkpoint_reference,runtime_status_reference,canonical_reference,raw_staging_reference,priority,is_incremental,is_backfill,is_enabled,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true,NOW(),NOW())
     ON CONFLICT (dataset_key) DO UPDATE SET asset_type=EXCLUDED.asset_type,dataset_name=EXCLUDED.dataset_name,master_entity_type=EXCLUDED.master_entity_type,target_mode=EXCLUDED.target_mode,new_assets_auto_included=EXCLUDED.new_assets_auto_included,source_provider=EXCLUDED.source_provider,update_mode=EXCLUDED.update_mode,expected_frequency=EXCLUDED.expected_frequency,freshness_policy=EXCLUDED.freshness_policy,freshness_grace_seconds=EXCLUDED.freshness_grace_seconds,target_universe_source=EXCLUDED.target_universe_source,worker_name=EXCLUDED.worker_name,checkpoint_reference=EXCLUDED.checkpoint_reference,runtime_status_reference=EXCLUDED.runtime_status_reference,canonical_reference=EXCLUDED.canonical_reference,raw_staging_reference=EXCLUDED.raw_staging_reference,priority=EXCLUDED.priority,is_incremental=EXCLUDED.is_incremental,is_backfill=EXCLUDED.is_backfill,updated_at=NOW()`,
    definition.key, definition.asset, definition.name, definition.entity, definition.targetMode, definition.auto, definition.provider, definition.updateMode,
    definition.frequency, json(definition.policy), definition.graceSeconds ?? null, definition.universe, definition.worker ?? null, definition.checkpoint ?? null,
    definition.runtime ?? null, definition.canonical, definition.raw ?? null, definition.priority, definition.incremental, definition.backfill,
  );
}

async function runtimeEvidence(definition: DatasetDefinition): Promise<RuntimeEvidence & Row> {
  const statusPath = definition.runtime ?? runtimePath(definition.asset);
  const status = await readFile(statusPath, "utf8").then((value) => JSON.parse(value) as Row).catch(() => ({}));
  const scheduler = definition.schedulerLike ? await one(
    `SELECT processed,succeeded,failed,updated_at,last_symbol,run_type FROM production_scheduler_checkpoints WHERE job_id LIKE $1 ORDER BY updated_at DESC LIMIT 1`, definition.schedulerLike,
  ).catch(() => ({})) : {};
  const legacy = definition.key === "STOCK_DAILY_HISTORY" ? await one(
    `SELECT status,total_count,success_count,failed_count,updated_at FROM history_jobs WHERE status='RUNNING' ORDER BY updated_at ASC LIMIT 1`,
  ).catch(() => ({})) : {};
  const pid = integer(status.PROCESS_ID ?? status.process_id ?? status.processId);
  const heartbeat = date(status.HEARTBEAT_AT ?? status.heartbeat_at ?? status.updatedAt);
  const nextRun = date(status.NEXT_RUN_AT ?? status.next_run_at ?? status.nextRunAt);
  const checkpointAt = date(scheduler.updated_at ?? status.LAST_PROGRESS_AT ?? status.last_progress_at ?? status.updatedAt);
  const legacyUpdatedAt = date(legacy.updated_at);
  const legacyCurrent = Boolean(legacy.total_count && legacyUpdatedAt && now.valueOf() - legacyUpdatedAt.valueOf() <= 24 * 3_600_000);
  const explicitPending = Math.max(0, Number(status.PENDING_COUNT ?? status.pending_count ?? 0));
  const productModulePending = definition.key === "ETF_AUM"
    ? Math.max(0, Number(status.retryWait ?? 0) + Number(status.retryExhausted ?? 0), String(status.state ?? "") === "AUTO_CONTINUING" ? 1 : 0)
    : 0;
  const pending = legacyCurrent ? Math.max(0, Number(legacy.total_count) - Number(legacy.success_count ?? 0) - Number(legacy.failed_count ?? 0)) : Math.max(explicitPending, productModulePending);
  const runtimeState = String(status.RUN_STATE ?? status.run_state ?? status.state ?? (schedulerRecent ? "SCHEDULED_WAIT" : "UNKNOWN"));
  const activeLabel = ["RUNNING", "SCHEDULED_WAIT", "AUTO_CONTINUING"].includes(runtimeState);
  const alive = pidAlive(pid);
  const schedulerRecent = date(scheduler.updated_at) ? now.valueOf() - date(scheduler.updated_at)!.valueOf() < 24 * 3_600_000 : false;
  const heartbeatStale = legacyCurrent ? true : (heartbeat ? now.valueOf() - heartbeat.valueOf() > 30 * 60_000 : !schedulerRecent);
  const nextRunOverdue = !schedulerRecent && (nextRun ? now.valueOf() - nextRun.valueOf() > 15 * 60_000 : false);
  const futureRunScheduled = Boolean(nextRun && nextRun.valueOf() > now.valueOf());
  return {
    state: runtimeState, runtimeActive: (activeLabel && alive && !heartbeatStale) || schedulerRecent,
    heartbeatStale, nextRunOverdue, futureRunScheduled, pending, lastError: String(status.BLOCKER ?? status.blocker ?? "") || null, pid, heartbeatAt: heartbeat,
    nextRunAt: nextRun, checkpointAt, checkpointCursor: status.CHECKPOINT ?? status.checkpoint ?? scheduler.last_symbol ?? null,
    lastAttemptAt: date(scheduler.updated_at ?? heartbeat), lastSuccessAt: Number(scheduler.succeeded ?? 0) > 0 ? date(scheduler.updated_at) : null,
    retryCount: Number(scheduler.failed ?? 0), consecutiveFailures: Number(scheduler.failed ?? 0), scheduler, status, legacy: { ...legacy, classification: legacy.total_count ? (legacyCurrent ? "VALID_PENDING" : "OBSOLETE_LEGACY_STATE") : "NONE" },
  };
}

const PRIMARY = new Set(["STOCK_CURRENT_PRICE", "STOCK_DAILY_HISTORY", "ETF_CURRENT_PRICE", "FUND_NAV", "INDEX_LEVEL", "FUTURES_CONTRACT_HISTORY", "FIXED_INCOME_YIELD", "FX_SPOT", "MACRO_VALUES", "CRYPTO_PRICE"]);
async function primaryCoverage(definition: DatasetDefinition): Promise<Row> {
  switch (definition.asset) {
    case "STOCK": {
      if (definition.key !== "STOCK_DAILY_HISTORY") return one(`SELECT count(*)::bigint master,count(*) FILTER(WHERE is_active)::bigint target,count(*) FILTER(WHERE latest_date IS NOT NULL)::bigint ever,count(*) FILTER(WHERE latest_date>=CURRENT_DATE-INTERVAL '4 days')::bigint current,max(latest_date)::text latest,max(updated_at)::text written FROM stocks`);
      const physical = await readFile("runtime/p0-repair-board/stock-physical-history.json", "utf8").then((value) => JSON.parse(value) as Row).catch(() => null);
      const generatedAt = physical ? date(physical.generatedAt) : null;
      if (!physical || !generatedAt || now.valueOf() - generatedAt.valueOf() > 24 * 3_600_000) return { master: 80_944, target: 80_944, ever: null, current: null, latest: null, written: null, limitation: "PHYSICAL_STOCK_HISTORY_CENSUS_MISSING_OR_STALE" };
      const usable = physical.historyUsable as Row, current = physical.historyCurrent as Row, runtime = physical.runtime as Row;
      return { master: physical.universe, target: physical.universe, ever: usable.numerator, current: current.numerator, latest: physical.latestHistory, written: runtime.lastSuccess, physicalPresent: physical.historyPresent, physicalUsable: usable, physicalCurrent: current, method: physical.evidenceMethod };
    }
    case "ETF": return one(`SELECT count(*)::bigint master,count(*) FILTER(WHERE is_active)::bigint target,count(*) FILTER(WHERE price_updated_at IS NOT NULL)::bigint ever,count(*) FILTER(WHERE price_updated_at>=NOW()-INTERVAL '4 days')::bigint current,max(price_updated_at)::text latest,max(updated_at)::text written FROM etfs`);
    case "FUND": return one(`SELECT count(*)::bigint master,count(*) FILTER(WHERE is_active)::bigint target,count(*) FILTER(WHERE latest_nav_date IS NOT NULL)::bigint ever,count(*) FILTER(WHERE latest_nav_date>=CURRENT_DATE-INTERVAL '10 days')::bigint current,max(latest_nav_date)::text latest,max(nav_updated_at)::text written FROM funds`);
    case "INDEX": return one(`SELECT (SELECT count(*) FROM global_index_registry)::bigint master,(SELECT count(*) FROM global_index_registry WHERE active)::bigint target,count(DISTINCT index_id)::bigint ever,count(DISTINCT index_id) FILTER(WHERE latest_at>=CURRENT_DATE-INTERVAL '4 days')::bigint current,max(latest_at)::text latest,max(checked_at)::text written FROM global_index_coverage WHERE row_count>0`);
    case "FUTURES": return one(`SELECT (SELECT count(*) FROM futures_product_roots)::bigint master,$1::bigint target,count(DISTINCT c.root_id)::bigint ever,count(DISTINCT c.root_id) FILTER(WHERE o.observed_at>=CURRENT_DATE-INTERVAL '4 days')::bigint current,max(o.observed_at)::text latest,max(o.retrieved_at)::text written FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id`, definition.configuredTargetCount ?? 5);
    case "FIXED_INCOME": return one(`SELECT (SELECT count(*) FROM bond_instruments)::bigint master,$1::bigint target,count(DISTINCT COALESCE(bond_id,security_id))::bigint ever,count(DISTINCT COALESCE(bond_id,security_id)) FILTER(WHERE observation_date>=CURRENT_DATE-INTERVAL '10 days')::bigint current,max(observation_date)::text latest,max(updated_at)::text written FROM bond_market_observations`, definition.configuredTargetCount ?? 10);
    case "FX": return one(`SELECT (SELECT count(*) FROM fx_pairs)::bigint master,(SELECT count(*) FROM fx_pairs WHERE active)::bigint target,count(DISTINCT pair_symbol)::bigint ever,count(DISTINCT pair_symbol) FILTER(WHERE latest_at>=NOW()-INTERVAL '2 days')::bigint current,max(latest_at)::text latest,max(checked_at)::text written FROM fx_coverage WHERE row_count>0`);
    case "MACRO": return one(`SELECT (SELECT count(*) FROM economic_series)::bigint master,(SELECT count(*) FROM economic_series WHERE enabled)::bigint target,count(DISTINCT series_id)::bigint ever,count(DISTINCT series_id) FILTER(WHERE freshness_status IN ('CURRENT','FRESH','HEALTHY'))::bigint current,max(latest_observation_at)::text latest,max(checked_at)::text written FROM economic_freshness`);
    case "CRYPTO": return one(`SELECT (SELECT count(*) FROM crypto_markets)::bigint master,(SELECT count(*) FROM crypto_markets WHERE active)::bigint target,count(DISTINCT asset_id)::bigint ever,count(DISTINCT asset_id) FILTER(WHERE latest_at>=NOW()-INTERVAL '6 hours')::bigint current,max(latest_at)::text latest,max(checked_at)::text written FROM crypto_coverage WHERE row_count>0`);
    default: return {};
  }
}

async function coverageEvidence(definition: DatasetDefinition): Promise<CoverageEvidence & Row> {
  if (ADAPTER_KEYS.has(definition.key)) {
    const row = await readDatasetCoverage(prisma, definition);
    const master = integer(row.master), target = integer(row.target), ever = integer(row.ever), current = integer(row.current);
    return { master, target, ever, current, stale: ever !== null && current !== null ? Math.max(0, ever-current) : null, never: target !== null && ever !== null ? Math.max(0, target-ever) : null, outside: master !== null && target !== null ? Math.max(0, master-target) : null, latest: date(row.latest), written: date(row.written), coveragePercent: pct(ever, master), currentPercent: pct(current, target), promotionLagSeconds: null, rawAvailable: false, rawLayerStatus: "RAW_LAYER_NOT_AVAILABLE", canonicalRows: integer(row.rows), adapterStatus: row.adapterStatus, details: { adapterStatus: row.adapterStatus, confidence: row.confidence, grain: row.grain, limitation: row.limitation ?? null, earliestObservationAt: row.earliest ?? null, rowCount: integer(row.rows) } };
  }
  if (!PRIMARY.has(definition.key)) {
    const table = await one(`SELECT to_regclass($1)::text name`, `public.${definition.canonical}`);
    if (!table.name) return { master: null, target: definition.configuredTargetCount ?? null, ever: null, current: null, promotionLagSeconds: null, rawAvailable: false, rawLayerStatus: "RAW_LAYER_NOT_AVAILABLE", canonicalRows: null };
    const count = await one(`SELECT GREATEST(reltuples,0)::bigint rows FROM pg_class WHERE oid=to_regclass($1)`, `public.${definition.canonical}`);
    return { master: null, target: definition.configuredTargetCount ?? null, ever: null, current: null, promotionLagSeconds: null, rawAvailable: false, rawLayerStatus: "RAW_LAYER_NOT_AVAILABLE", canonicalRows: integer(count.rows), details: { method: "TABLE_LEVEL_ESTIMATE_ONLY" } };
  }
  const row = await primaryCoverage(definition);
  const master = integer(row.master), target = integer(row.target), ever = integer(row.ever), current = integer(row.current);
  return {
    master, target, ever, current, stale: ever !== null && current !== null ? Math.max(0, ever - current) : null,
    never: target !== null && ever !== null ? Math.max(0, target - ever) : null, outside: master !== null && target !== null ? Math.max(0, master - target) : null,
    latest: date(row.latest), written: date(row.written), coveragePercent: pct(ever, master), currentPercent: pct(current, target), promotionLagSeconds: null,
    rawAvailable: false, rawLayerStatus: "RAW_LAYER_NOT_AVAILABLE", canonicalRows: null, details: { method: row.method ?? "CANONICAL_MASTER_OR_COVERAGE_LEDGER", limitation: row.limitation ?? null, physicalPresent: row.physicalPresent ?? null, physicalUsable: row.physicalUsable ?? null, physicalCurrent: row.physicalCurrent ?? null },
  };
}

async function persist(definition: DatasetDefinition, runtime: RuntimeEvidence & Row, coverage: CoverageEvidence & Row, evaluation: { state: string; reasons: string[] }): Promise<void> {
  if (dryRun) return;
  const runtimeId = randomUUID(), coverageId = randomUUID();
  await prisma.$transaction(async (tx) => {
    const priorCoverageRows = await tx.$queryRawUnsafe<Array<{ master_count: number | null; target_count: number | null; current_count: number | null; never_synced_count: number | null }>>(`SELECT master_count,target_count,current_count,never_synced_count FROM dataset_coverage_observations WHERE dataset_key=$1 ORDER BY observed_at DESC LIMIT 1`, definition.key);
    const priorCoverage: PreviousCoverage | null = priorCoverageRows[0] ? { master: priorCoverageRows[0].master_count, target: priorCoverageRows[0].target_count, current: priorCoverageRows[0].current_count, never: priorCoverageRows[0].never_synced_count } : null;
    await tx.$executeRawUnsafe(`INSERT INTO dataset_runtime_observations (id,dataset_key,runtime_state,pid,heartbeat_at,last_attempt_at,last_success_at,next_run_at,checkpoint_at,checkpoint_cursor,last_error,retry_count,consecutive_failures,execution_success,source_success,raw_write_success,canonical_write_success,validation_success,data_current,pending_count,worker_observed_at,details) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),$21::jsonb)`, runtimeId, definition.key, runtime.state, runtime.pid ?? null, runtime.heartbeatAt ?? null, runtime.lastAttemptAt ?? null, runtime.lastSuccessAt ?? null, runtime.nextRunAt ?? null, runtime.checkpointAt ?? null, runtime.checkpointCursor ? String(runtime.checkpointCursor) : null, runtime.lastError ?? null, runtime.retryCount ?? 0, runtime.consecutiveFailures ?? 0, runtime.lastSuccessAt ? "YES" : "UNKNOWN", runtime.lastError ? "NO" : "UNKNOWN", "UNKNOWN", coverage.written ? "YES" : "UNKNOWN", "UNKNOWN", coverage.current && coverage.current > 0 ? "YES" : "NO", runtime.pending, json({ scheduler: runtime.scheduler, legacy: runtime.legacy }));
    await tx.$executeRawUnsafe(`INSERT INTO dataset_coverage_observations (id,dataset_key,master_count,target_count,ever_success_count,current_count,stale_count,never_synced_count,outside_scope_count,latest_observation_at,last_canonical_write_at,coverage_percent,current_percent,raw_latest_at,raw_rows,canonical_latest_at,canonical_rows,promotion_lag_seconds,raw_layer_status,observed_at,details) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),$20::jsonb)`, coverageId, definition.key, coverage.master, coverage.target, coverage.ever, coverage.current, coverage.stale ?? null, coverage.never ?? null, coverage.outside ?? null, coverage.latest ?? null, coverage.written ?? null, coverage.coveragePercent ?? null, coverage.currentPercent ?? null, coverage.rawLatest ?? null, coverage.rawRows ?? null, coverage.latest ?? null, coverage.canonicalRows ?? null, coverage.promotionLagSeconds, coverage.rawLayerStatus, json(coverage.details ?? {}));
    const prior = await tx.$queryRawUnsafe<Array<{ health_state: string; condition_started_at: Date }>>(`SELECT health_state,condition_started_at FROM dataset_health_states WHERE dataset_key=$1`, definition.key);
    const started = prior[0]?.health_state === evaluation.state ? prior[0].condition_started_at : now;
    await tx.$executeRawUnsafe(`INSERT INTO dataset_health_states (dataset_key,health_state,reason_codes,runtime_observation_id,coverage_observation_id,condition_started_at,evaluated_at,updated_at) VALUES ($1,$2,$3::jsonb,$4::uuid,$5::uuid,$6,NOW(),NOW()) ON CONFLICT(dataset_key) DO UPDATE SET health_state=EXCLUDED.health_state,reason_codes=EXCLUDED.reason_codes,runtime_observation_id=EXCLUDED.runtime_observation_id,coverage_observation_id=EXCLUDED.coverage_observation_id,condition_started_at=EXCLUDED.condition_started_at,evaluated_at=NOW(),updated_at=NOW()`, definition.key, evaluation.state, json(evaluation.reasons), runtimeId, coverageId, started);
    const conditions = evaluateAlertConditions(evaluation.state, coverage, priorCoverage);
    for (const condition of conditions) {
      const dedupe = `${definition.key}:${condition}`;
      await tx.$executeRawUnsafe(`INSERT INTO dataset_alert_events (id,dataset_key,condition,status,severity,dedupe_key,first_observed_at,last_observed_at,occurrence_count,details) VALUES ($1::uuid,$2,$3,'OPEN',$4,$5,NOW(),NOW(),1,$6::jsonb) ON CONFLICT (dedupe_key) WHERE status='OPEN' DO UPDATE SET last_observed_at=NOW(),occurrence_count=dataset_alert_events.occurrence_count+1,severity=EXCLUDED.severity,details=EXCLUDED.details`, randomUUID(), definition.key, condition, alertSeverity(condition, definition.priority), dedupe, json({ policyVersion: "GLOBAL_DATA_WATCHDOG_V1", healthState: evaluation.state, reasons: evaluation.reasons }));
    }
    await tx.$executeRawUnsafe(`UPDATE dataset_alert_events SET status='RESOLVED',resolved_at=NOW(),last_observed_at=NOW() WHERE dataset_key=$1 AND status='OPEN' AND NOT (condition=ANY($2::text[]))`, definition.key, conditions);
  });
}

async function main(): Promise<void> {
  const selected = DATASETS.filter((item) => (!selectedAsset || item.asset === selectedAsset) && (!selectedDataset || item.key === selectedDataset));
  const output: Row[] = [];
  for (const definition of selected) {
    try {
      if (trace) console.error(`[health-refresh] start ${definition.key}`);
      await register(definition);
      const [runtime, coverage] = await Promise.all([runtimeEvidence(definition), coverageEvidence(definition)]);
      const evaluation = evaluateHealth(definition, runtime, coverage);
      await persist(definition, runtime, coverage, evaluation);
      output.push({ datasetKey: definition.key, asset: definition.asset, healthState: evaluation.state, reasons: evaluation.reasons, master: coverage.master, target: coverage.target, ever: coverage.ever, current: coverage.current });
      if (trace) console.error(`[health-refresh] complete ${definition.key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const runtime: RuntimeEvidence & Row = { state: "UNKNOWN", runtimeActive: false, heartbeatStale: true, nextRunOverdue: false, pending: 0, lastError: message };
      const coverage: CoverageEvidence & Row = { master: null, target: null, ever: null, current: null, promotionLagSeconds: null, rawAvailable: false, rawLayerStatus: "RAW_LAYER_NOT_AVAILABLE", details: { adapterError: message } };
      await persist(definition, runtime, coverage, { state: "UNKNOWN", reasons: ["EVALUATION_FAILED"] }).catch(() => undefined);
      output.push({ datasetKey: definition.key, asset: definition.asset, healthState: "UNKNOWN", reasons: ["EVALUATION_FAILED"], error: message });
    }
  }
  console.log(json({ mode: dryRun ? "DRY_RUN" : "CONTROL_PLANE_WRITE", observedAt: now.toISOString(), datasets: output }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
