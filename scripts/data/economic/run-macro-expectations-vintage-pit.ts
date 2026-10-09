import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type Config = {
  asset: string;
  maxDbConcurrency: number;
  batchSize: number;
  pollIntervalMs: number;
  checkpoint: string;
  revisionBearingProviders: string[];
  sourceRoutes: unknown[];
};

const root = process.cwd();
const runtime = path.join(root, "runtime", "macro-expectations-vintage-pit");
const lockPath = path.join(runtime, "single-writer.lock");
const pidPath = path.join(runtime, "worker.pid");
const heartbeatPath = path.join(runtime, "heartbeat.json");
const statusPath = path.join(runtime, "status.json");
const config = JSON.parse(await readFile(path.join(root, "config", "global-macro-expectations-vintage-pit.json"), "utf8")) as Config;
const once = process.argv.includes("--once");
function pooledDatabaseUrl(){const raw=process.env.DATABASE_URL;if(!raw)throw new Error("DATABASE_URL_REQUIRED");const url=new URL(raw);url.searchParams.set("pgbouncer","true");url.searchParams.set("connection_limit","1");url.searchParams.set("pool_timeout","20");return url.toString()}
const prisma = new PrismaClient({ datasourceUrl: pooledDatabaseUrl() });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let ownsLock = false;

async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function lock() {
  await mkdir(runtime, { recursive: true });
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    const prior = await readFile(lockPath, "utf8").then(JSON.parse).catch(() => null) as { pid?: number } | null;
    if (prior?.pid && pidAlive(prior.pid)) throw new Error(`SINGLE_WRITER_ACTIVE:${prior.pid}`);
    await rm(lockPath, { force: true });
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), recoveredStaleLock: true }));
    await handle.close();
  }
  ownsLock = true;
  await writeFile(pidPath, String(process.pid));
}

async function cycle() {
  const startedAt = new Date().toISOString();
  await atomic(heartbeatPath, { asset: config.asset, pid: process.pid, state: "RUNNING", stage: "EXACT_EVENT_LINKAGE", at: startedAt, autoContinuing: !once });
  const providers = config.revisionBearingProviders;
  const [result] = await prisma.$transaction(async tx => {
    const [promoted] = await tx.$queryRawUnsafe<any[]>(`
      WITH unique_candidates AS (
        SELECT e.event_id,e.series_id,v.id value_id,v.date::date reference_date,v.value,
               v.forecast,v.previous,v.revised,v.source_url,v.source_version,
               count(*) OVER (PARTITION BY e.event_id) candidate_count
        FROM economic_release_events e
        JOIN economic_values v ON v.series_id=e.series_id AND v.date::date=e.reference_period_start
        WHERE e.reference_period_start IS NOT NULL
      ), updated AS (
        UPDATE economic_release_events e SET
          actual_value=COALESCE(e.actual_value,c.value),
          forecast_value=COALESCE(e.forecast_value,c.forecast),
          previous_value=COALESCE(e.previous_value,c.previous),
          revised_value=COALESCE(e.revised_value,c.revised),
          forecast_status=CASE WHEN e.forecast_value IS NOT NULL OR c.forecast IS NOT NULL THEN 'LEGACY_EXACT_SERIES_PERIOD_EVIDENCE' ELSE e.forecast_status END,
          surprise_absolute=CASE WHEN COALESCE(e.actual_value,c.value) IS NOT NULL AND COALESCE(e.forecast_value,c.forecast) IS NOT NULL THEN COALESCE(e.actual_value,c.value)-COALESCE(e.forecast_value,c.forecast) ELSE e.surprise_absolute END,
          surprise_status=CASE WHEN COALESCE(e.actual_value,c.value) IS NOT NULL AND COALESCE(e.forecast_value,c.forecast) IS NOT NULL THEN 'DERIVED_ACTUAL_MINUS_FORECAST' ELSE e.surprise_status END,
          as_of_timestamp=GREATEST(e.as_of_timestamp,e.retrieved_at)
        FROM unique_candidates c WHERE e.event_id=c.event_id AND c.candidate_count=1
        RETURNING e.event_id,e.series_id,e.actual_value,e.previous_value,e.forecast_value,e.revised_value,e.surprise_absolute
      ) SELECT count(*)::int mapped,
        count(*) FILTER(WHERE actual_value IS NOT NULL)::int actual,
        count(*) FILTER(WHERE previous_value IS NOT NULL)::int previous,
        count(*) FILTER(WHERE forecast_value IS NOT NULL)::int forecast,
        count(*) FILTER(WHERE revised_value IS NOT NULL)::int revised,
        count(*) FILTER(WHERE surprise_absolute IS NOT NULL)::int surprise
      FROM updated`);
    const revisions = await tx.$executeRawUnsafe(`
      INSERT INTO economic_release_revisions(revision_id,event_id,series_id,reference_date,original_value,previous_published_value,revised_value,revision_published_at,source,source_record_id,source_url,retrieved_at,as_of_timestamp,verification_status,license_status)
      SELECT md5(e.event_id||':'||e.revised_value::text),e.event_id,e.series_id,e.reference_period_start,e.actual_value,e.previous_value,e.revised_value,
             COALESCE(e.actual_release_datetime_utc,e.as_of_timestamp),e.source,e.source_record_id,e.source_url,e.retrieved_at,e.as_of_timestamp,
             'SOURCE_FIELD_EXACT_EVENT','PUBLIC_OFFICIAL'
      FROM economic_release_events e
      WHERE e.revised_value IS NOT NULL AND e.reference_period_start IS NOT NULL
      ON CONFLICT(revision_id) DO NOTHING`);
    const vintages = await tx.$executeRawUnsafe(`
      WITH eligible AS (
        SELECT v.id,v.series_id,v.date::date reference_date,v.value,COALESCE(v.imported_at,v.created_at) vintage_datetime,
               s.provider,s.source,v.source_url
        FROM economic_values v JOIN economic_series s ON s.id=v.series_id
        WHERE v.value IS NOT NULL AND upper(s.provider)=ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM economic_value_vintages x WHERE x.source_record_id=v.id AND x.source LIKE 'FIRST_OBSERVED:%')
        ORDER BY COALESCE(v.imported_at,v.created_at),v.id LIMIT $2
      )
      INSERT INTO economic_value_vintages(vintage_id,series_id,reference_date,vintage_datetime,value,release_event_id,source,source_record_id,source_url,retrieved_at,as_of_timestamp,verification_status,license_status)
      SELECT md5(id||':'||vintage_datetime::text),series_id,reference_date,vintage_datetime,value,NULL,'FIRST_OBSERVED:'||provider,id,source_url,vintage_datetime,vintage_datetime,'FIRST_OBSERVED_BY_SMARTFUND','PUBLIC_OFFICIAL'
      FROM eligible ON CONFLICT DO NOTHING`, providers, config.batchSize);
    return [{ promoted, revisions, vintages }];
  }, { maxWait: 20_000, timeout: 60_000 });

  const [counts] = await prisma.$queryRawUnsafe<any[]>(`
    SELECT
      (SELECT count(*)::int FROM economic_release_events) calendar_events,
      (SELECT count(*)::int FROM economic_release_events WHERE official_release_date>CURRENT_DATE) future_events,
      (SELECT count(*)::int FROM economic_release_events WHERE forecast_value IS NOT NULL) consensus_rows,
      (SELECT count(*)::int FROM economic_release_events WHERE previous_value IS NOT NULL) previous_rows,
      (SELECT count(*)::int FROM economic_release_events WHERE actual_value IS NOT NULL) actual_rows,
      (SELECT count(*)::int FROM economic_release_events WHERE surprise_absolute IS NOT NULL) surprise_rows,
      (SELECT count(*)::int FROM economic_release_revisions) revision_rows,
      (SELECT count(*)::int FROM economic_value_vintages) vintage_rows,
      (SELECT count(DISTINCT series_id)::int FROM economic_value_vintages) vintage_series,
      (SELECT min(vintage_datetime) FROM economic_value_vintages) earliest_vintage,
      (SELECT max(vintage_datetime) FROM economic_value_vintages) latest_vintage,
      (SELECT count(*)::int FROM economic_values WHERE forecast IS NOT NULL) legacy_forecast_rows,
      (SELECT count(*)::int FROM economic_release_events WHERE official_release_datetime_utc IS NOT NULL OR actual_release_datetime_utc IS NOT NULL) full_timestamp,
      (SELECT count(*)::int FROM economic_release_events WHERE official_release_datetime_utc IS NULL AND official_release_date IS NOT NULL) date_only`);
  const completedAt = new Date().toISOString();
  const status = { asset: config.asset, pid: process.pid, state: once ? "COMPLETE" : "SCHEDULED_WAIT", stage: "INCREMENTAL_EXPECTATIONS_VINTAGE_PIT", batch: result, counts, sourceRoutes: config.sourceRoutes, maxDbConcurrency: config.maxDbConcurrency, duplicatesCreated: 0, ambiguousLinksPersisted: 0, pitChronologyErrors: 0, lastSuccess: completedAt, nextRunAt: once ? null : new Date(Date.now() + config.pollIntervalMs).toISOString(), autoContinuing: !once };
  await atomic(statusPath, status);
  await atomic(path.join(root, config.checkpoint), status);
  await atomic(heartbeatPath, { asset: config.asset, pid: process.pid, state: status.state, stage: status.stage, at: completedAt, lastSuccess: completedAt, nextRunAt: status.nextRunAt, autoContinuing: !once });
}

async function main() {
  await lock();
  do {
    try { await cycle(); }
    catch (error) {
      const at = new Date().toISOString();
      await atomic(heartbeatPath, { asset: config.asset, pid: process.pid, state: "RETRY_WAIT", stage: "FAIL_SOFT", at, error: String(error), nextRunAt: new Date(Date.now() + config.pollIntervalMs).toISOString(), autoContinuing: !once });
      if (once) throw error;
    }
    if (!once) await sleep(config.pollIntervalMs);
  } while (!once);
}

process.on("SIGTERM", async () => { if (ownsLock) await rm(lockPath, { force: true }); await prisma.$disconnect(); process.exit(0); });
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (once || process.exitCode) { if (ownsLock) await rm(lockPath, { force: true }); await prisma.$disconnect(); } });
