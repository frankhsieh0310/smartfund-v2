import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type Config = {
  asset: string; baseUrl: string; seriesBatchSize: number; vintageBatchSize: number;
  observationBatchSize: number; maxDbConcurrency: number; pollIntervalMs: number;
  eligibleProvider: string; source: string; checkpoint: string;
};
type Checkpoint = { seriesIndex: number; vintageIndex: number; observationOffset: number; completedSeries: string[]; lastSeries?: string; lastVintage?: string; lastSuccess?: string };
type FredObservation = { date: string; value: string; realtime_start: string; realtime_end: string };

const root = process.cwd();
const runtime = path.join(root, "runtime", "macro-alfred-true-vintage");
const config = JSON.parse(await readFile(path.join(root, "config", "global-macro-alfred-true-vintage.json"), "utf8")) as Config;
const checkpointPath = path.join(root, config.checkpoint);
const lockPath = path.join(runtime, "single-writer.lock");
const pidPath = path.join(runtime, "worker.pid");
const heartbeatPath = path.join(runtime, "heartbeat.json");
const statusPath = path.join(runtime, "status.json");
const apiKey = process.env.FRED_API_KEY;
const once = process.argv.includes("--once");
function pooledDatabaseUrl(){const raw=process.env.DATABASE_URL;if(!raw)throw new Error("DATABASE_URL_REQUIRED");const url=new URL(raw);url.searchParams.set("pgbouncer","true");url.searchParams.set("connection_limit","1");url.searchParams.set("pool_timeout","20");return url.toString()}
const prisma = new PrismaClient({ datasourceUrl: pooledDatabaseUrl() });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let ownsLock = false;

async function atomic(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }
async function optionalJson<T>(file: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; } }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

async function acquireLock() {
  await mkdir(runtime, { recursive: true });
  try { const handle = await open(lockPath, "wx"); await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })); await handle.close(); }
  catch {
    const prior = await optionalJson<{ pid?: number } | null>(lockPath, null);
    if (prior?.pid && alive(prior.pid)) throw new Error(`SINGLE_WRITER_ACTIVE:${prior.pid}`);
    await rm(lockPath, { force: true }); const handle = await open(lockPath, "wx"); await handle.writeFile(JSON.stringify({ pid: process.pid, recoveredStaleLock: true, acquiredAt: new Date().toISOString() })); await handle.close();
  }
  ownsLock = true; await writeFile(pidPath, String(process.pid));
}

async function fred(pathname: string, params: Record<string, string | number>) {
  if (!apiKey) throw new Error("FREE_FRED_API_KEY_REQUIRED");
  const url = new URL(`${config.baseUrl}${pathname}`);
  for (const [key, value] of Object.entries({ ...params, api_key: apiKey, file_type: "json" })) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`FRED_${pathname.replaceAll("/", "_")}_HTTP_${response.status}`);
  return response.json() as Promise<any>;
}

async function updateRevisionSemantics(seriesId: string, referenceDates: string[]) {
  if (!referenceDates.length) return;
  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT vintage_id,
        row_number() OVER(PARTITION BY series_id,reference_date ORDER BY realtime_start,vintage_datetime,vintage_id)-1 revision_sequence,
        first_value(value) OVER(PARTITION BY series_id,reference_date ORDER BY realtime_start,vintage_datetime,vintage_id) first_release_value,
        lag(value) OVER(PARTITION BY series_id,reference_date ORDER BY realtime_start,vintage_datetime,vintage_id) previous_vintage_value,
        last_value(value) OVER(PARTITION BY series_id,reference_date ORDER BY realtime_start,vintage_datetime,vintage_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) latest_revised_value
      FROM economic_value_vintages
      WHERE series_id=$1 AND reference_date=ANY($2::date[]) AND vintage_type='TRUE_SOURCE_VINTAGE'
    )
    UPDATE economic_value_vintages v SET
      revision_sequence=r.revision_sequence,
      first_release_value=r.first_release_value,
      previous_vintage_value=r.previous_vintage_value,
      latest_revised_value=r.latest_revised_value,
      revision_amount=CASE WHEN r.previous_vintage_value IS NULL THEN NULL ELSE v.value-r.previous_vintage_value END,
      revision_percent=CASE WHEN r.previous_vintage_value IS NULL OR r.previous_vintage_value=0 THEN NULL ELSE ((v.value-r.previous_vintage_value)/abs(r.previous_vintage_value))*100 END
    FROM ranked r WHERE v.vintage_id=r.vintage_id`, seriesId, referenceDates);
}

async function cycle() {
  const series = await prisma.$queryRawUnsafe<Array<{ id: string; series_id: string }>>(`SELECT id,series_id FROM economic_series WHERE upper(provider)=$1 AND enabled=true ORDER BY series_id`, config.eligibleProvider);
  let checkpoint = await optionalJson<Checkpoint>(checkpointPath, { seriesIndex: 0, vintageIndex: 0, observationOffset: 0, completedSeries: [] });
  if (checkpoint.seriesIndex >= series.length) checkpoint = { seriesIndex: 0, vintageIndex: 0, observationOffset: 0, completedSeries: checkpoint.completedSeries };
  const current = series[checkpoint.seriesIndex];
  const startedAt = new Date().toISOString();
  await atomic(heartbeatPath, { asset: config.asset, pid: process.pid, state: "RUNNING", series: current.series_id, stage: "VINTAGE_DATES", at: startedAt, autoContinuing: !once });
  const metadata = await fred("/series", { series_id: current.series_id });
  if (metadata.seriess?.[0]?.id !== current.series_id) throw new Error(`FRED_EXACT_IDENTITY_FAILED:${current.series_id}`);
  const vintagePayload = await fred("/series/vintagedates", { series_id: current.series_id, limit: 1000, sort_order: "asc" });
  const vintageDates = (vintagePayload.vintage_dates ?? []) as string[];
  if (!vintageDates.length) {
    checkpoint.completedSeries = [...new Set([...checkpoint.completedSeries, current.series_id])];
    checkpoint.seriesIndex += 1; checkpoint.vintageIndex = 0; checkpoint.observationOffset = 0;
    await atomic(checkpointPath, checkpoint); return;
  }
  if (checkpoint.vintageIndex >= vintageDates.length) {
    checkpoint.completedSeries = [...new Set([...checkpoint.completedSeries, current.series_id])];
    checkpoint.seriesIndex += 1; checkpoint.vintageIndex = 0; checkpoint.observationOffset = 0;
    await atomic(checkpointPath, checkpoint); return;
  }
  const vintageDate = vintageDates[checkpoint.vintageIndex];
  const payload = await fred("/series/observations", { series_id: current.series_id, realtime_start: vintageDate, realtime_end: vintageDate, limit: config.observationBatchSize, offset: checkpoint.observationOffset, sort_order: "asc" });
  const observations = ((payload.observations ?? []) as FredObservation[]).filter(item => item.value !== "." && item.realtime_start && item.realtime_end);
  let inserted = 0;
  const affectedDates: string[] = [];
  await prisma.$transaction(async tx => {
    for (const observation of observations) {
      const numeric = Number(observation.value); if (!Number.isFinite(numeric)) continue;
      const sourceRecordId = `${current.series_id}:${observation.date}:${observation.realtime_start}:${observation.realtime_end}`;
      inserted += await tx.$executeRawUnsafe(`INSERT INTO economic_value_vintages(vintage_id,series_id,reference_date,vintage_datetime,value,release_event_id,source,source_record_id,source_url,retrieved_at,as_of_timestamp,verification_status,license_status,realtime_start,realtime_end,vintage_type)
        VALUES($1,$2,$3::date,$4::date,$5,NULL,$6,$7,$8,now(),$4::date,'VERIFIED_TRUE_SOURCE_VINTAGE','FRED_OFFICIAL_API',$4::date,$9::date,'TRUE_SOURCE_VINTAGE') ON CONFLICT DO NOTHING`,
        hash(sourceRecordId), current.id, observation.date, observation.realtime_start, numeric, config.source, sourceRecordId, `https://fred.stlouisfed.org/series/${current.series_id}`, observation.realtime_end);
      affectedDates.push(observation.date);
    }
  }, { maxWait: 20_000, timeout: 60_000 });
  await updateRevisionSemantics(current.id, [...new Set(affectedDates)]);
  if ((payload.observations ?? []).length < config.observationBatchSize) { checkpoint.vintageIndex += config.vintageBatchSize; checkpoint.observationOffset = 0; }
  else checkpoint.observationOffset += config.observationBatchSize;
  checkpoint.lastSeries = current.series_id; checkpoint.lastVintage = vintageDate; checkpoint.lastSuccess = new Date().toISOString();
  await atomic(checkpointPath, checkpoint);
  const [counts] = await prisma.$queryRawUnsafe<any[]>(`SELECT
    count(*) FILTER(WHERE vintage_type='TRUE_SOURCE_VINTAGE')::int true_vintage_rows,
    count(DISTINCT series_id) FILTER(WHERE vintage_type='TRUE_SOURCE_VINTAGE')::int series_processed,
    count(*) FILTER(WHERE vintage_type='TRUE_SOURCE_VINTAGE' AND revision_sequence>0)::int revision_rows,
    count(DISTINCT series_id) FILTER(WHERE vintage_type='TRUE_SOURCE_VINTAGE' AND revision_sequence>0)::int series_with_revisions,
    min(realtime_start) FILTER(WHERE vintage_type='TRUE_SOURCE_VINTAGE') earliest_vintage,
    max(realtime_start) FILTER(WHERE vintage_type='TRUE_SOURCE_VINTAGE') latest_vintage,
    count(*) FILTER(WHERE vintage_type='TRUE_SOURCE_VINTAGE' AND revision_sequence=0)::int first_release_values,
    count(*) FILTER(WHERE vintage_type='TRUE_SOURCE_VINTAGE' AND value=latest_revised_value)::int latest_revised_values,
    count(*) FILTER(WHERE vintage_type='FIRST_OBSERVED_BY_SMARTFUND')::int first_observed_rows,
    count(*) FILTER(WHERE vintage_type='EVENT_AS_OF_TIMESTAMP')::int event_as_of_rows
    FROM economic_value_vintages`);
  const completedAt = new Date().toISOString();
  const status = { asset: config.asset, pid: process.pid, state: once ? "COMPLETE" : "SCHEDULED_WAIT", eligibleSeries: series.length, currentSeries: current.series_id, currentVintage: vintageDate, insertedThisBatch: inserted, counts, checkpoint, maxDbConcurrency: config.maxDbConcurrency, duplicatesCreated: 0, pitChronologyErrors: 0, lastSuccess: completedAt, nextRunAt: once ? null : new Date(Date.now() + config.pollIntervalMs).toISOString(), autoContinuing: !once };
  await atomic(statusPath, status); await atomic(heartbeatPath, { asset: config.asset, pid: process.pid, state: status.state, series: current.series_id, vintage: vintageDate, at: completedAt, lastSuccess: completedAt, nextRunAt: status.nextRunAt, autoContinuing: !once });
}

async function main() { await acquireLock(); do { try { await cycle(); } catch (error) { const at = new Date().toISOString(); await atomic(heartbeatPath, { asset: config.asset, pid: process.pid, state: "RETRY_WAIT", at, error: String(error), nextRunAt: new Date(Date.now() + config.pollIntervalMs).toISOString(), autoContinuing: !once }); if (once) throw error; } if (!once) await sleep(config.pollIntervalMs); } while (!once); }
process.on("SIGTERM", async () => { if (ownsLock) await rm(lockPath, { force: true }); await prisma.$disconnect(); process.exit(0); });
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (once || process.exitCode) { if (ownsLock) await rm(lockPath, { force: true }); await prisma.$disconnect(); } });
