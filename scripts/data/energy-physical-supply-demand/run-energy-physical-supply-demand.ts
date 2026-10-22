import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

type Metric = {
  code: string; name: string; series: string; commodity: string; commodityFamily: string;
  product: string; category: string; expectedUnit: string; flowDirection: string | null;
  facilityType: string | null; measurementBasis: string; seasonalAdjustment: string;
};
type Config = {
  asset: string; country: string; source: string; endpoint: string; sourceUrl: string;
  methodologyVersion: string; frequency: string; pollIntervalMs: number;
  retry: { maxAttempts: number; baseDelayMs: number };
  freshness: { waitingDays: number; staleDays: number };
  metrics: Metric[]; metricTaxonomy: string[];
};
type EiaRow = {
  period: string; series: string; "series-description": string; value: string; units: string;
  duoarea: string; "area-name": string; product: string; "product-name": string;
  process: string; "process-name": string;
  "source-version"?: string;
};
type CanonicalRow = {
  id: string; seriesId: string; country: string; commodity: string; metricCode: string;
  metricName: string; observationDate: string; value: string; unit: string; frequency: string;
  flowDirection: string | null; facilityType: string | null; source: string;
  sourceRecordId: string; sourceUrl: string; retrievedAt: string; verificationState: string;
  rawChecksum: string;
};

if (process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER) {
  process.env.DATABASE_URL = process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER;
}
const prisma = new PrismaClient();
const root = resolve("runtime/energy-physical-supply-demand");
const paths = {
  checkpoint: resolve(root, "checkpoint.json"), status: resolve(root, "status.json"),
  p0: resolve(root, "p0-recovery-result.json"), coverage: resolve(root, "coverage-matrix.json"),
  heartbeat: resolve(root, "heartbeat.json"), lock: resolve(root, "single-writer.lock"),
  pid: resolve(root, "supervisor.pid"), log: resolve(root, "runner.log"),
};
const config = JSON.parse(await readFile(resolve("config/energy-physical-supply-demand.json"), "utf8")) as Config;
const once = process.argv.includes("--once") || process.argv.includes("--canary") || process.argv.includes("--historical");
const historical = process.argv.includes("--historical");
const applySchema = process.argv.includes("--apply-schema");
let ownsLock = false;

const now = () => new Date().toISOString();
const dateOnly = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const seriesId = (metric: Metric) => `US_EIA_${metric.series}`;
const checksum = (row: EiaRow) => createHash("sha256").update(JSON.stringify(row)).digest("hex");
async function atomic(path: string, value: unknown) { const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, path); }
async function log(event: string, detail: unknown = {}) { await writeFile(paths.log, `${now()} ${event} ${JSON.stringify(detail)}\n`, { flag: "a" }); }
async function lock() { await mkdir(root, { recursive: true }); const handle = await open(paths.lock, "wx"); await handle.writeFile(JSON.stringify({ pid: process.pid, command: process.argv.join(" "), acquiredAt: now() })); await handle.close(); ownsLock = true; }
async function unlock() { if (ownsLock) await rm(paths.lock, { force: true }); ownsLock = false; }

function validateConfig() {
  const required = ["PRODUCTION", "REFINERY_INPUT", "PRODUCT_SUPPLIED", "IMPORT", "EXPORT", "INVENTORY", "REFINERY_UTILIZATION"];
  for (const category of required) if (!config.metrics.some((metric) => metric.category === category)) throw new Error(`P0_METRIC_MISSING:${category}`);
  for (const metric of config.metrics) {
    if (!config.metricTaxonomy.includes(metric.category)) throw new Error(`UNKNOWN_METRIC_TAXONOMY:${metric.category}`);
    if (!metric.series || !metric.expectedUnit || !metric.measurementBasis) throw new Error(`INCOMPLETE_SERIES_IDENTITY:${metric.code}`);
  }
}

async function schema() {
  if (!applySchema) return;
  const sql = await readFile(resolve("prisma/migrations/20260810090000_energy_physical_p0_professional_depth/migration.sql"), "utf8");
  for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement);
}

async function request(params: URLSearchParams) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${config.endpoint}?${params}`, { headers: { Accept: "application/json", "user-agent": "SmartFund energy physical P0 recovery" }, signal: AbortSignal.timeout(60_000) });
      const payload = await response.json() as { response?: { total?: string; data?: EiaRow[] }; error?: { code?: string; message?: string } };
      if (response.status === 429) {
        const retryAfterSeconds = Math.max(1, Number(response.headers.get("retry-after") ?? 60));
        const boundedCooldownMs = Math.min(config.pollIntervalMs, retryAfterSeconds * 1_000);
        await log("SOURCE_RATE_LIMIT_WAIT", { attempt, retryAfterSeconds, boundedCooldownMs, sourceConcurrency: 1 });
        await sleep(boundedCooldownMs);
      }
      if (!response.ok || payload.error) throw new Error(`EIA_${response.status}:${payload.error?.code ?? "HTTP"}:${payload.error?.message ?? ""}`);
      return { total: Number(payload.response?.total ?? 0), rows: payload.response?.data ?? [] };
    } catch (error) {
      lastError = error; await log("FETCH_RETRY", { attempt, error: String(error) });
      if (attempt < config.retry.maxAttempts) await sleep(config.retry.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function query(offset: number, length: number) {
  const params = new URLSearchParams({ api_key: process.env.EIA_API_KEY || "DEMO_KEY", frequency: "weekly", offset: String(offset), length: String(length) });
  params.append("data[0]", "value");
  for (const metric of config.metrics) params.append("facets[series][]", metric.series);
  params.append("sort[0][column]", "period"); params.append("sort[0][direction]", historical ? "asc" : "desc");
  return params;
}

async function fetchRows() {
  const bulkPath = resolve(process.env.EIA_PET_BULK_PATH || "runtime/energy-physical-supply-demand/eia-pet-bulk-20260806/PET.txt");
  if (!historical) {
    try { return (await request(query(0, config.metrics.length))).rows; }
    catch (error) {
      await log("LATEST_API_FALLBACK_TO_OFFICIAL_BULK", { error: String(error), bulkPath });
      return fetchBulkRows(bulkPath, true);
    }
  }
  const bulk = await fetchBulkRows(bulkPath, false);
  if (bulk.length) return bulk;
  const rows: EiaRow[] = []; let offset = 0; let total = Infinity;
  while (offset < total) {
    const page = await request(query(offset, 5000)); total = page.total; rows.push(...page.rows); offset += page.rows.length;
    await log("HISTORICAL_PAGE", { offset, total });
    if (!page.rows.length) break;
    if (offset < total) await sleep(750);
  }
  return rows;
}

async function fetchBulkRows(path: string, latestOnly: boolean) {
  const rows: EiaRow[] = []; const wanted = new Map(config.metrics.map((metric) => [`PET.${metric.series}.W`, metric]));
  const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of input) {
    if (![...wanted.keys()].some((id) => line.includes(`"series_id":"${id}"`))) continue;
    const item = JSON.parse(line) as { series_id?: string; name?: string; f?: string; last_updated?: string; data?: Array<[string, number | string]> };
    const metric = item.series_id ? wanted.get(item.series_id) : undefined;
    if (!metric || item.f !== "W" || !Array.isArray(item.data)) continue;
    const observations = latestOnly ? item.data.slice(0, 1) : item.data;
    for (const [rawDate, value] of observations) {
      const period = `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`;
      rows.push({ period, series: metric.series, "series-description": metric.name, value: String(value), units: metric.expectedUnit, duoarea: "NUS", "area-name": "U.S.", product: metric.product, "product-name": metric.product, process: metric.category, "process-name": metric.category, "source-version": item.last_updated });
    }
    await log("BULK_SERIES_PARSED", { series: metric.series, rows: observations.length, latestOnly, sourceVersion: item.last_updated });
  }
  const found = new Set(rows.map((row) => row.series));
  if (found.size !== config.metrics.length) throw new Error(`BULK_SERIES_MISSING:${config.metrics.filter((metric) => !found.has(metric.series)).map((metric) => metric.series).join(",")}`);
  return rows;
}

function parseRows(sourceRows: EiaRow[]) {
  const retrievedAt = now(); const valid: CanonicalRow[] = []; const invalid: Array<{ row: EiaRow; reason: string }> = [];
  const metricMap = new Map(config.metrics.map((metric) => [metric.series, metric]));
  for (const row of sourceRows) {
    const metric = metricMap.get(row.series); let reason = "";
    if (!metric) reason = "UNKNOWN_SERIES";
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(row.period)) reason = "INVALID_DATE";
    else if (!Number.isFinite(Number(row.value))) reason = "INVALID_VALUE";
    else if (row.units !== metric.expectedUnit) reason = `UNIT_MISMATCH:${row.units}`;
    else if (row["area-name"] !== "U.S.") reason = `GEOGRAPHY_MISMATCH:${row["area-name"]}`;
    if (reason || !metric) { invalid.push({ row, reason }); continue; }
    valid.push({ id: randomUUID(), seriesId: seriesId(metric), country: config.country, commodity: metric.commodity, metricCode: metric.code, metricName: row["series-description"], observationDate: row.period, value: row.value, unit: row.units, frequency: config.frequency, flowDirection: metric.flowDirection, facilityType: metric.facilityType, source: config.source, sourceRecordId: `${row.series}:${row.period}`, sourceUrl: config.sourceUrl, retrievedAt, verificationState: "OFFICIAL_SOURCE_VERIFIED", rawChecksum: checksum(row) });
  }
  return { valid, invalid };
}

async function seedSeries(rows: CanonicalRow[]) {
  for (const metric of config.metrics) {
    const dates = rows.filter((row) => row.seriesId === seriesId(metric)).map((row) => row.observationDate).sort();
    await prisma.$executeRawUnsafe(
      `INSERT INTO energy_physical_series (id,country,geography_level,geography_code,commodity,commodity_family,product,metric_code,metric_name,supply_demand_category,flow_direction,facility_type,frequency,unit,provider,source_series_id,source_url,status,start_date,end_date,measurement_basis,seasonal_adjustment,methodology_version,created_at,updated_at)
       VALUES ($1,'US','NATIONAL','NUS',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'U.S. ENERGY INFORMATION ADMINISTRATION',$12,$13,'ACTIVE',$14::date,NULL,$15,$16,$17,now(),now())
       ON CONFLICT (id) DO UPDATE SET metric_name=EXCLUDED.metric_name,supply_demand_category=EXCLUDED.supply_demand_category,unit=EXCLUDED.unit,status='ACTIVE',start_date=LEAST(energy_physical_series.start_date,EXCLUDED.start_date),measurement_basis=EXCLUDED.measurement_basis,methodology_version=EXCLUDED.methodology_version,updated_at=now()`,
      seriesId(metric), metric.commodity, metric.commodityFamily, metric.product, metric.code, metric.name, metric.category, metric.flowDirection, metric.facilityType, config.frequency, metric.expectedUnit, metric.series, config.sourceUrl, dates[0] ?? null, metric.measurementBasis, metric.seasonalAdjustment, config.methodologyVersion,
    );
  }
}

async function writeRows(rows: CanonicalRow[]) {
  let revisions = 0;
  for (let offset = 0; offset < rows.length; offset += 1000) {
    const chunk = rows.slice(offset, offset + 1000); const json = JSON.stringify(chunk);
    const revisionRows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("seriesId" text,"observationDate" text,"value" text,"rawChecksum" text)), ins AS (
       INSERT INTO energy_physical_revisions (id,series_id,observation_date,previous_value,revised_value,source_checksum,ingestion_version)
       SELECT gen_random_uuid()::text,i."seriesId",i."observationDate"::date,o.value,i.value::numeric,i."rawChecksum",o.ingestion_version+1
       FROM incoming i JOIN energy_physical_observations o ON o.series_id=i."seriesId" AND o.observation_date=i."observationDate"::date
       WHERE o.value<>i.value::numeric ON CONFLICT DO NOTHING RETURNING 1) SELECT count(*)::int count FROM ins`, json,
    );
    revisions += revisionRows[0]?.count ?? 0;
    await prisma.$executeRawUnsafe(
      `WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,"seriesId" text,country text,commodity text,"metricCode" text,"metricName" text,"observationDate" text,value text,unit text,frequency text,"flowDirection" text,"facilityType" text,source text,"sourceRecordId" text,"sourceUrl" text,"retrievedAt" text,"verificationState" text,"rawChecksum" text))
       INSERT INTO energy_physical_observations (id,series_id,country,commodity,metric_code,metric_name,observation_date,period_start,period_end,value,unit,frequency,flow_direction,facility_type,source,source_record_id,source_url,retrieved_at,verification_state,raw_checksum,ingestion_version,created_at,updated_at)
       SELECT id,"seriesId",country,commodity,"metricCode","metricName","observationDate"::date,NULL,"observationDate"::date,value::numeric,unit,frequency,"flowDirection","facilityType",source,"sourceRecordId","sourceUrl","retrievedAt"::timestamp,"verificationState","rawChecksum",1,now(),now() FROM incoming
       ON CONFLICT (country,commodity,metric_code,observation_date,source) DO UPDATE SET series_id=EXCLUDED.series_id,metric_name=EXCLUDED.metric_name,value=EXCLUDED.value,unit=EXCLUDED.unit,frequency=EXCLUDED.frequency,flow_direction=EXCLUDED.flow_direction,facility_type=EXCLUDED.facility_type,source_record_id=EXCLUDED.source_record_id,source_url=EXCLUDED.source_url,retrieved_at=EXCLUDED.retrieved_at,verification_state=EXCLUDED.verification_state,raw_checksum=EXCLUDED.raw_checksum,ingestion_version=CASE WHEN energy_physical_observations.value<>EXCLUDED.value THEN energy_physical_observations.ingestion_version+1 ELSE energy_physical_observations.ingestion_version END,updated_at=now()`, json,
    );
  }
  return revisions;
}

async function buildAnalytics() {
  await prisma.$executeRawUnsafe(`
    WITH base AS (
      SELECT series_id,observation_date,value,unit,
        lag(value,1) OVER w p1,lag(value,4) OVER w p4,lag(value,13) OVER w p13,lag(value,26) OVER w p26,lag(value,52) OVER w p52,
        first_value(value) OVER (PARTITION BY series_id,date_part('year',observation_date) ORDER BY observation_date) py,
        avg(value) OVER (PARTITION BY series_id ORDER BY observation_date ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) avg4,
        percent_rank() OVER (PARTITION BY series_id ORDER BY value) pct,
        max(value) OVER (PARTITION BY series_id ORDER BY observation_date ROWS BETWEEN 51 PRECEDING AND CURRENT ROW) hi52,
        min(value) OVER (PARTITION BY series_id ORDER BY observation_date ROWS BETWEEN 51 PRECEDING AND CURRENT ROW) lo52
      FROM energy_physical_observations WHERE series_id IS NOT NULL WINDOW w AS (PARTITION BY series_id ORDER BY observation_date)
    ), changes AS (SELECT *,value-p1 delta,stddev_samp(value-p1) OVER (PARTITION BY series_id ORDER BY observation_date ROWS BETWEEN 12 PRECEDING AND CURRENT ROW) vol13 FROM base),
    analytics AS (
      SELECT series_id,observation_date,'LEVEL_CHANGE_WOW' code,value-p1 val,unit out_unit FROM changes WHERE p1 IS NOT NULL UNION ALL
      SELECT series_id,observation_date,'GROWTH_WOW_PCT',100*(value/p1-1),'%' FROM changes WHERE p1<>0 UNION ALL
      SELECT series_id,observation_date,'GROWTH_MOM_PCT',100*(value/p4-1),'%' FROM changes WHERE p4<>0 UNION ALL
      SELECT series_id,observation_date,'GROWTH_3M_PCT',100*(value/p13-1),'%' FROM changes WHERE p13<>0 UNION ALL
      SELECT series_id,observation_date,'GROWTH_6M_PCT',100*(value/p26-1),'%' FROM changes WHERE p26<>0 UNION ALL
      SELECT series_id,observation_date,'GROWTH_YTD_PCT',100*(value/py-1),'%' FROM changes WHERE py<>0 UNION ALL
      SELECT series_id,observation_date,'GROWTH_YOY_PCT',100*(value/p52-1),'%' FROM changes WHERE p52<>0 UNION ALL
      SELECT series_id,observation_date,'ROLLING_AVERAGE_4W',avg4,unit FROM changes UNION ALL
      SELECT series_id,observation_date,'HISTORICAL_PERCENTILE',100*pct,'%' FROM changes UNION ALL
      SELECT series_id,observation_date,'PHYSICAL_CHANGE_VOLATILITY_13W',vol13,unit FROM changes WHERE vol13 IS NOT NULL UNION ALL
      SELECT series_id,observation_date,'HIGH_52W',hi52,unit FROM changes UNION ALL
      SELECT series_id,observation_date,'LOW_52W',lo52,unit FROM changes
    )
    INSERT INTO energy_physical_analytics (id,series_id,observation_date,analytic_code,value,unit,formula_version,created_at,updated_at)
    SELECT gen_random_uuid()::text,series_id,observation_date,code,val,out_unit,'PHYSICAL_CHANGE_V1',now(),now() FROM analytics WHERE val IS NOT NULL
    ON CONFLICT (series_id,observation_date,analytic_code) DO UPDATE SET value=EXCLUDED.value,unit=EXCLUDED.unit,formula_version=EXCLUDED.formula_version,updated_at=now()`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO energy_physical_analytics (id,series_id,observation_date,analytic_code,value,unit,formula_version,created_at,updated_at)
    SELECT gen_random_uuid()::text,i.series_id,i.observation_date,'NET_IMPORTS',i.value-e.value,i.unit,'ALIGNED_IMPORT_MINUS_EXPORT_V1',now(),now()
    FROM energy_physical_observations i JOIN energy_physical_series si ON si.id=i.series_id AND si.supply_demand_category='IMPORT'
    JOIN energy_physical_observations e ON e.observation_date=i.observation_date JOIN energy_physical_series se ON se.id=e.series_id AND se.supply_demand_category='EXPORT' AND se.product=si.product AND se.country=si.country
    ON CONFLICT (series_id,observation_date,analytic_code) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`);
}

async function buildCoverage() {
  await prisma.$executeRawUnsafe(`
    WITH stats AS (SELECT s.id series_id,count(o.id)::int observations,min(o.observation_date) earliest,max(o.observation_date) latest,(max(o.observation_date)-min(o.observation_date))::int depth,
      bool_and(o.source_url IS NOT NULL AND o.source_record_id IS NOT NULL AND o.verification_state='OFFICIAL_SOURCE_VERIFIED') provenance,
      EXISTS(SELECT 1 FROM energy_physical_analytics a WHERE a.series_id=s.id) analytics
      FROM energy_physical_series s LEFT JOIN energy_physical_observations o ON o.series_id=s.id GROUP BY s.id)
    INSERT INTO energy_physical_coverage (series_id,identity_ready,current_ready,history_ready,history_depth_days,taxonomy_ready,analytics_ready,provenance_ready,freshness_state,revision_ready,detail_ready,observation_count,earliest_date,latest_date,updated_at)
    SELECT s.id,true,st.latest IS NOT NULL,st.depth>=365,coalesce(st.depth,0),true,st.analytics,coalesce(st.provenance,false),
      CASE WHEN s.status='DISCONTINUED' THEN 'DISCONTINUED' WHEN current_date-st.latest<=$1 THEN 'WAITING_FOR_NEXT_RELEASE' WHEN current_date-st.latest<=$2 THEN 'SOURCE_DELAYED' ELSE 'STALE' END,
      true,(st.depth>=365 AND st.analytics AND coalesce(st.provenance,false)),st.observations,st.earliest,st.latest,now()
    FROM energy_physical_series s JOIN stats st ON st.series_id=s.id
    ON CONFLICT (series_id) DO UPDATE SET identity_ready=EXCLUDED.identity_ready,current_ready=EXCLUDED.current_ready,history_ready=EXCLUDED.history_ready,history_depth_days=EXCLUDED.history_depth_days,taxonomy_ready=EXCLUDED.taxonomy_ready,analytics_ready=EXCLUDED.analytics_ready,provenance_ready=EXCLUDED.provenance_ready,freshness_state=EXCLUDED.freshness_state,revision_ready=EXCLUDED.revision_ready,detail_ready=EXCLUDED.detail_ready,observation_count=EXCLUDED.observation_count,earliest_date=EXCLUDED.earliest_date,latest_date=EXCLUDED.latest_date,updated_at=now()`, config.freshness.waitingDays, config.freshness.staleDays);
}

async function reconcile(source: CanonicalRow[]) {
  const canonical = await prisma.$queryRawUnsafe<Array<{ series_id: string; observation_date: Date; value: unknown }>>(`SELECT series_id,observation_date,value FROM energy_physical_observations WHERE series_id=ANY($1::text[])`, config.metrics.map(seriesId));
  const sourceMap = new Map(source.map((row) => [`${row.seriesId}|${row.observationDate}`, Number(row.value)]));
  const canonicalMap = new Map(canonical.map((row) => [`${row.series_id}|${row.observation_date.toISOString().slice(0,10)}`, Number(row.value)]));
  let missing = 0, extra = 0, conflicts = 0;
  for (const [key, value] of sourceMap) { if (!canonicalMap.has(key)) missing += 1; else if (canonicalMap.get(key) !== value) conflicts += 1; }
  for (const key of canonicalMap.keys()) if (!sourceMap.has(key)) extra += 1;
  return { sourceRows: sourceMap.size, canonicalRows: canonicalMap.size, missing, extra, conflicts };
}

async function cycle() {
  const sourceRows = await fetchRows(); const parsed = parseRows(sourceRows);
  if (parsed.invalid.length) throw new Error(`FAIL_CLOSED_INVALID_ROWS:${parsed.invalid.length}`);
  const duplicateKeys = parsed.valid.length - new Set(parsed.valid.map((row) => `${row.seriesId}|${row.observationDate}`)).size;
  if (duplicateKeys) throw new Error(`FAIL_CLOSED_DUPLICATE_SOURCE_KEYS:${duplicateKeys}`);
  await seedSeries(parsed.valid); const revisions = await writeRows(parsed.valid); await buildAnalytics(); await buildCoverage();
  const reconciliation = historical ? await reconcile(parsed.valid) : null;
  if (reconciliation && (reconciliation.missing || reconciliation.extra || reconciliation.conflicts)) throw new Error(`FAIL_CLOSED_RECONCILIATION:${JSON.stringify(reconciliation)}`);
  const coverage = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT s.id,s.metric_code,s.supply_demand_category,c.* FROM energy_physical_series s JOIN energy_physical_coverage c ON c.series_id=s.id ORDER BY s.metric_code`);
  const completedAt = now(); const latestDates = coverage.map((row) => dateOnly(row.latest_date));
  await atomic(paths.coverage, coverage);
  const result = { task: "ENERGY_PHYSICAL_SUPPLY_DEMAND_P0_PROFESSIONAL_DEPTH_RECOVERY_V1", mode: historical ? "HISTORICAL" : "LATEST", sourceRows: sourceRows.length, parsedRows: parsed.valid.length, canonicalRows: reconciliation?.canonicalRows ?? null, duplicateRows: duplicateKeys, invalidRows: parsed.invalid.length, failedRows: 0, revisionsDetected: revisions, reconciliation, seriesCount: coverage.length, detailReadyCount: coverage.filter((row) => row.detail_ready).length, earliestDate: coverage.map((row) => row.earliest_date).filter(Boolean).sort()[0], latestDate: latestDates.sort().at(-1), completedAt };
  if (historical) await atomic(paths.p0, result);
  const nextEligibleAt = new Date(Date.now() + config.pollIntervalMs).toISOString();
  await atomic(paths.checkpoint, { asset: config.asset, country: config.country, series: coverage.map((row) => ({ seriesId: row.id, metric: row.metric_code, lastCanonicalDate: dateOnly(row.latest_date), lastSuccessfulRun: completedAt, nextEligibleAt })), lastSuccessfulRun: completedAt, nextEligibleAt, dedup: true, upsert: true, resume: true, boundedRetry: config.retry.maxAttempts, failureIsolation: "PER_CYCLE_FAIL_CLOSED", updatedAt: completedAt });
  await atomic(paths.status, { ...result, asset: config.asset, fetch: "PASS", parse: "PASS", semantics: "PASS", identity: "PASS", latestPath: "YES", historicalPath: historical ? "YES" : "READY", incremental: "YES", scheduler: once ? "READY" : "ACTIVE", autoContinuing: !once, singleWriter: true, status: once ? "PARTIAL_CURRENT" : "HEALTHY_WAITING" });
  await atomic(paths.heartbeat, { asset: config.asset, pid: process.pid, alive: true, stage: once ? "P0_RECOVERY_COMPLETE" : "HEALTHY_WAITING", singleWriter: true, heartbeatAt: completedAt });
  return result;
}

async function main() {
  validateConfig(); await lock(); await schema(); if (!once) await writeFile(paths.pid, String(process.pid));
  do {
    try { await cycle(); }
    catch (error) {
      if (once) throw error;
      const retryAt = new Date(Date.now() + config.pollIntervalMs).toISOString(); await log("CYCLE_ISOLATED", { error: String(error), retryAt });
      await atomic(paths.heartbeat, { asset: config.asset, pid: process.pid, alive: true, stage: "SOURCE_RECOVERY_PENDING", error: String(error), retryAt, singleWriter: true, heartbeatAt: now() });
    }
    if (once) break; await sleep(config.pollIntervalMs);
  } while (true);
}

process.on("SIGTERM", async () => { await atomic(paths.heartbeat, { asset: config.asset, pid: process.pid, alive: false, stage: "STOPPED", heartbeatAt: now() }); await unlock(); await prisma.$disconnect(); process.exit(0); });
main().catch(async (error) => { await log("FATAL", { error: String(error instanceof Error ? error.stack : error) }); await atomic(paths.heartbeat, { asset: config.asset, pid: process.pid, alive: false, stage: "FAILED", error: String(error), heartbeatAt: now() }); process.exitCode = 1; }).finally(async () => { if (once || process.exitCode) { await unlock(); await prisma.$disconnect(); } });
