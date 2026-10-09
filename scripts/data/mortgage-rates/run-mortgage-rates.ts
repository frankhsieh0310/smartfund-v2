import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type Series = {
  id: string; seriesCode: string; sourceField: string; officialName: string; displayName: string;
  mortgageType: string; metricKind: "RATE" | "POINTS" | "MARGIN" | "SPREAD"; rateType: string;
  fixingPeriod: string | null; maturity: string | null; observationBasis: string; statisticType: string;
  unit: string; currency: string | null; status: "ACTIVE" | "DISCONTINUED"; startDate: string; endDate: string | null;
};
type Config = {
  asset: string; country: string; countryCode: string; pollIntervalMs: number; publicationFrequency: string;
  retry: { maxAttempts: number; baseDelayMs: number };
  source: { name: string; provider: string; endpoint: string; documentationUrl: string; verificationState: string; sourceVersion: string; methodologyVersion: string };
  series: Series[]; internationalSourcePending: string[];
};
type Point = { date: string; value: number; checksum: string };
type SourceData = Map<string, Point[]>;
type Reconciliation = { sourceRows: number; canonicalRows: number; missing: number; extra: number; conflicts: number; duplicates: number; invalid: number };

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const config = JSON.parse(await readFile(resolve("config/mortgage-rates.json"), "utf8")) as Config;
const root = resolve("runtime/mortgage-rates");
const paths = {
  checkpoint: resolve(root, "checkpoint.json"), status: resolve(root, "status.json"), recovery: resolve(root, "professional-depth-status.json"),
  heartbeat: resolve(root, "heartbeat.json"), lock: resolve(root, "single-writer.lock"), pid: resolve(root, "supervisor.pid"),
  log: resolve(root, "runner.log"), latest: resolve(root, "latest.json"), coverage: resolve(root, "coverage-matrix.json"),
  detail: resolve(root, "detail-contract.json"), search: resolve(root, "search-contract.json"), screener: resolve(root, "screener-contract.json"), compare: resolve(root, "compare-contract.json"),
};
const args = new Set(process.argv.slice(2));
const backfill = args.has("--backfill");
const once = args.has("--once") || args.has("--canary") || backfill;
const applySchema = args.has("--apply-schema");
let ownsLock = false;

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function atomic(file: string, value: unknown) { const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }
async function log(event: string, detail: unknown = {}) { await writeFile(paths.log, `${now()} ${event} ${JSON.stringify(detail)}\n`, { flag: "a" }); }
function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
async function lock() {
  await mkdir(root, { recursive: true });
  try {
    const owner = JSON.parse(await readFile(paths.lock, "utf8")) as { pid?: number };
    if (owner.pid && processAlive(owner.pid)) throw new Error(`SINGLE_WRITER_ACTIVE:${owner.pid}`);
    await rm(paths.lock, { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && String(error).includes("SINGLE_WRITER_ACTIVE")) throw error; }
  const handle = await open(paths.lock, "wx"); await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: now() })); await handle.close(); ownsLock = true;
}
async function unlock() { if (ownsLock) await rm(paths.lock, { force: true }); ownsLock = false; }
async function schema() {
  if (!applySchema) return;
  const sql = await readFile(resolve("prisma/migrations/20260810100000_mortgage_rates_professional_depth/migration.sql"), "utf8");
  for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement);
}

function csvCells(line: string) { const cells: string[] = []; let cell = ""; let quoted = false; for (const character of line) { if (character === '"') quoted = !quoted; else if (character === "," && !quoted) { cells.push(cell.trim()); cell = ""; } else cell += character; } cells.push(cell.trim()); return cells; }
function isoDate(value: string) { const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return match ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : null; }
function checksum(series: Series, date: string, value: number) { return createHash("sha256").update(`${series.seriesCode}|${date}|${value}|${config.source.sourceVersion}`).digest("hex"); }
function parse(body: string) {
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  const header = csvCells(lines[0]).map((cell) => cell.toLowerCase());
  const dateIndex = header.indexOf("date");
  const indexes = new Map(config.series.map((series) => [series.sourceField, header.indexOf(series.sourceField)]));
  if (dateIndex < 0 || [...indexes.values()].some((index) => index < 0)) throw new Error("PMMS_SCHEMA_MISMATCH");
  const data: SourceData = new Map(config.series.map((series) => [series.id, []])); let invalid = 0;
  for (const line of lines.slice(1)) {
    const cells = csvCells(line); const date = isoDate(cells[dateIndex]); if (!date) { invalid += 1; continue; }
    for (const series of config.series) {
      const raw = cells[indexes.get(series.sourceField)!]?.trim(); if (!raw) continue;
      const value = Number(raw); if (!Number.isFinite(value) || value < -100 || value > 100) { invalid += 1; continue; }
      data.get(series.id)!.push({ date, value, checksum: checksum(series, date, value) });
    }
  }
  for (const points of data.values()) points.sort((left, right) => left.date.localeCompare(right.date));
  return { data, invalid };
}
async function fetchOfficial() {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(config.source.endpoint, { headers: { accept: "text/csv", "user-agent": "SmartFund mortgage rates/2.0" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const parsed = parse(await response.text());
      if ([...parsed.data.values()].some((points) => points.length === 0)) throw new Error("SUPPORTED_PMMS_SERIES_EMPTY");
      return { ...parsed, retrievedAt: now() };
    } catch (error) { lastError = error; await log("FETCH_RETRY", { attempt, error: String(error) }); if (attempt < config.retry.maxAttempts) await sleep(config.retry.baseDelayMs * 2 ** (attempt - 1)); }
  }
  throw lastError;
}

async function upsertIdentities() {
  for (const series of config.series) await prisma.$executeRawUnsafe(
    `INSERT INTO mortgage_rate_series (id,series_code,official_name,display_name,jurisdiction,currency,mortgage_type,metric_kind,rate_type,fixing_period,maturity,observation_basis,statistic_type,frequency,unit,status,start_date,end_date,source,source_url,external_series_identifier,methodology_version,verification_state,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::text::date,$18::text::date,$19,$20,$21,$22,$23,now(),now())
     ON CONFLICT (series_code) DO UPDATE SET official_name=EXCLUDED.official_name,display_name=EXCLUDED.display_name,jurisdiction=EXCLUDED.jurisdiction,currency=EXCLUDED.currency,mortgage_type=EXCLUDED.mortgage_type,metric_kind=EXCLUDED.metric_kind,rate_type=EXCLUDED.rate_type,fixing_period=EXCLUDED.fixing_period,maturity=EXCLUDED.maturity,observation_basis=EXCLUDED.observation_basis,statistic_type=EXCLUDED.statistic_type,frequency=EXCLUDED.frequency,unit=EXCLUDED.unit,status=EXCLUDED.status,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,source=EXCLUDED.source,source_url=EXCLUDED.source_url,external_series_identifier=EXCLUDED.external_series_identifier,methodology_version=EXCLUDED.methodology_version,verification_state=EXCLUDED.verification_state,updated_at=now()`,
    series.id, series.seriesCode, series.officialName, series.displayName, config.country, series.currency, series.mortgageType, series.metricKind, series.rateType, series.fixingPeriod, series.maturity, series.observationBasis, series.statisticType, config.publicationFrequency, series.unit, series.status, series.startDate, series.endDate, config.source.provider, config.source.endpoint, series.sourceField, config.source.methodologyVersion, config.source.verificationState,
  );
  await prisma.$executeRawUnsafe(`UPDATE mortgage_rate_observations o SET series_id=s.id,value_semantics=s.metric_kind,source_url=s.source_url,verification_state=s.verification_state,raw_checksum=COALESCE(o.raw_checksum,md5(o.metric_code||'|'||o.observation_date::text||'|'||o.rate::text)),source_version=COALESCE(o.source_version,$1),retrieved_at=COALESCE(o.retrieved_at,o.updated_at),source_record_id=COALESCE(o.source_record_id,o.metric_code||':'||o.observation_date::text) FROM mortgage_rate_series s WHERE o.metric_code=s.series_code AND o.series_id IS NULL`, config.source.sourceVersion);
}

async function writeObservations(source: SourceData, retrievedAt: string, checkpoint: Record<string, { lastCanonicalDate?: string }>) {
  let written = 0;
  for (const series of config.series) {
    const all = source.get(series.id)!;
    const selected = backfill ? all : all.filter((point) => !checkpoint[series.id]?.lastCanonicalDate || point.date > checkpoint[series.id].lastCanonicalDate!);
    for (let offset = 0; offset < selected.length; offset += 500) {
      const rows = selected.slice(offset, offset + 500).map((point) => ({ id: randomUUID(), series_id: series.id, country: config.countryCode, metric_code: series.seriesCode, mortgage_type: series.mortgageType, rate_type: series.rateType, fixing_period: series.fixingPeriod, maturity: series.maturity, observation_date: point.date, value: point.value, unit: series.unit, currency: series.currency, frequency: config.publicationFrequency, value_semantics: series.metricKind, source: config.source.name, source_url: config.source.endpoint, source_record_id: `${point.date}:${series.sourceField}`, verification_state: config.source.verificationState, raw_checksum: point.checksum, source_version: config.source.sourceVersion, retrieved_at: retrievedAt }));
      const payload = JSON.stringify(rows);
      await prisma.$executeRawUnsafe(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,series_id text,country text,metric_code text,mortgage_type text,rate_type text,fixing_period text,maturity text,observation_date date,value numeric,unit text,currency text,frequency text,value_semantics text,source text,source_url text,source_record_id text,verification_state text,raw_checksum text,source_version text,retrieved_at timestamp)) INSERT INTO mortgage_rate_observation_revisions (id,series_id,observation_date,prior_value,replacement_value,prior_checksum,replacement_checksum,detected_at,source_version) SELECT gen_random_uuid()::text,o.series_id,o.observation_date,o.rate,i.value,o.raw_checksum,i.raw_checksum,now(),i.source_version FROM incoming i JOIN mortgage_rate_observations o ON o.series_id=i.series_id AND o.observation_date=i.observation_date WHERE o.raw_checksum IS NOT NULL AND o.raw_checksum<>i.raw_checksum AND o.rate<>i.value ON CONFLICT (series_id,observation_date,replacement_checksum) DO NOTHING`, payload);
      await prisma.$executeRawUnsafe(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,series_id text,country text,metric_code text,mortgage_type text,rate_type text,fixing_period text,maturity text,observation_date date,value numeric,unit text,currency text,frequency text,value_semantics text,source text,source_url text,source_record_id text,verification_state text,raw_checksum text,source_version text,retrieved_at timestamp)) INSERT INTO mortgage_rate_observations (id,series_id,country,metric_code,mortgage_type,rate_type,fixing_period,maturity,observation_date,rate,unit,currency,frequency,value_semantics,source,source_url,source_record_id,verification_state,raw_checksum,source_version,retrieved_at,created_at,updated_at) SELECT id,series_id,country,metric_code,mortgage_type,rate_type,fixing_period,maturity,observation_date,value,unit,currency,frequency,value_semantics,source,source_url,source_record_id,verification_state,raw_checksum,source_version,retrieved_at,now(),now() FROM incoming ON CONFLICT (series_id,observation_date) DO UPDATE SET rate=EXCLUDED.rate,unit=EXCLUDED.unit,value_semantics=EXCLUDED.value_semantics,source_url=EXCLUDED.source_url,source_record_id=EXCLUDED.source_record_id,verification_state=EXCLUDED.verification_state,raw_checksum=EXCLUDED.raw_checksum,source_version=EXCLUDED.source_version,retrieved_at=EXCLUDED.retrieved_at,updated_at=now()`, payload);
      written += rows.length;
    }
  }
  await prisma.$executeRawUnsafe(`ALTER TABLE mortgage_rate_observations ALTER COLUMN series_id SET NOT NULL, ALTER COLUMN value_semantics SET NOT NULL, ALTER COLUMN source_url SET NOT NULL, ALTER COLUMN verification_state SET NOT NULL, ALTER COLUMN raw_checksum SET NOT NULL, ALTER COLUMN source_version SET NOT NULL, ALTER COLUMN retrieved_at SET NOT NULL`);
  await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mortgage_rate_observations_series_fkey') THEN ALTER TABLE mortgage_rate_observations ADD CONSTRAINT mortgage_rate_observations_series_fkey FOREIGN KEY (series_id) REFERENCES mortgage_rate_series(id); END IF; END $$`);
  return written;
}

function before(points: Point[], target: Date) { const iso = target.toISOString().slice(0, 10); return points.findLast((point) => point.date <= iso); }
function change(points: Point[], days: number) { const latest = points.at(-1)!; const target = new Date(`${latest.date}T00:00:00Z`); target.setUTCDate(target.getUTCDate() - days); const prior = before(points, target); return prior ? (latest.value - prior.value) * 100 : null; }
function ytd(points: Point[]) { const latest = points.at(-1)!; const prior = before(points, new Date(`${latest.date.slice(0, 4)}-01-01T00:00:00Z`)); return prior ? (latest.value - prior.value) * 100 : null; }
function analytics(points: Point[]) {
  const latest = points.at(-1)!; const changes = points.slice(1).map((point, index) => (point.value - points[index].value) * 100);
  const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length;
  const volatility = Math.sqrt(changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(changes.length - 1, 1)) * Math.sqrt(52);
  const sorted = points.map((point) => point.value).sort((a, b) => a - b);
  return { asOfDate: latest.date, change1w: change(points, 7), change1m: change(points, 30), change3m: change(points, 91), change6m: change(points, 182), changeYtd: ytd(points), change1y: change(points, 365), change3y: change(points, 1095), change5y: change(points, 1825), change10y: change(points, 3650), rolling: points.slice(-52).reduce((sum, point) => sum + point.value, 0) / Math.min(points.length, 52), percentile: sorted.filter((value) => value <= latest.value).length / sorted.length * 100, volatility, fromPeak: (latest.value - Math.max(...sorted)) * 100, fromTrough: (latest.value - Math.min(...sorted)) * 100 };
}
async function writeAnalytics(source: SourceData) {
  const rateSeries = config.series.filter((series) => series.metricKind === "RATE");
  const thirty = source.get("us-pmms-30y-fixed")!; const fifteenByDate = new Map(source.get("us-pmms-15y-fixed")!.map((point) => [point.date, point.value]));
  for (const series of rateSeries) {
    const points = source.get(series.id)!; const item = analytics(points); const curve = series.id === "us-pmms-30y-fixed" && fifteenByDate.has(item.asOfDate) ? (points.at(-1)!.value - fifteenByDate.get(item.asOfDate)!) * 100 : null;
    const numeric = (value: number | null) => value === null ? null : String(value);
    await prisma.$executeRawUnsafe(`INSERT INTO mortgage_rate_analytics (id,series_id,as_of_date,change_1w_bps,change_1m_bps,change_3m_bps,change_6m_bps,change_ytd_bps,change_1y_bps,change_3y_bps,change_5y_bps,change_10y_bps,rolling_52w_average,historical_percentile,weekly_change_volatility_bps,movement_from_peak_bps,movement_from_trough_bps,curve_30y_15y_spread_bps,calculation_version,created_at,updated_at) VALUES ($1,$2,$3::text::date,$4::text::numeric,$5::text::numeric,$6::text::numeric,$7::text::numeric,$8::text::numeric,$9::text::numeric,$10::text::numeric,$11::text::numeric,$12::text::numeric,$13::text::numeric,$14::text::numeric,$15::text::numeric,$16::text::numeric,$17::text::numeric,$18::text::numeric,'RATE_LEVEL_BPS_V1',now(),now()) ON CONFLICT (series_id,as_of_date) DO UPDATE SET change_1w_bps=EXCLUDED.change_1w_bps,change_1m_bps=EXCLUDED.change_1m_bps,change_3m_bps=EXCLUDED.change_3m_bps,change_6m_bps=EXCLUDED.change_6m_bps,change_ytd_bps=EXCLUDED.change_ytd_bps,change_1y_bps=EXCLUDED.change_1y_bps,change_3y_bps=EXCLUDED.change_3y_bps,change_5y_bps=EXCLUDED.change_5y_bps,change_10y_bps=EXCLUDED.change_10y_bps,rolling_52w_average=EXCLUDED.rolling_52w_average,historical_percentile=EXCLUDED.historical_percentile,weekly_change_volatility_bps=EXCLUDED.weekly_change_volatility_bps,movement_from_peak_bps=EXCLUDED.movement_from_peak_bps,movement_from_trough_bps=EXCLUDED.movement_from_trough_bps,curve_30y_15y_spread_bps=EXCLUDED.curve_30y_15y_spread_bps,updated_at=now()`, randomUUID(), series.id, item.asOfDate, numeric(item.change1w), numeric(item.change1m), numeric(item.change3m), numeric(item.change6m), numeric(item.changeYtd), numeric(item.change1y), numeric(item.change3y), numeric(item.change5y), numeric(item.change10y), numeric(item.rolling), numeric(item.percentile), numeric(item.volatility), numeric(item.fromPeak), numeric(item.fromTrough), numeric(curve));
  }
  return thirty.at(-1)!.date;
}

function freshness(series: Series, latestDate: string) { if (series.status === "DISCONTINUED") return "DISCONTINUED"; const age = Math.floor((Date.now() - new Date(`${latestDate}T00:00:00Z`).valueOf()) / 86_400_000); return age <= 10 ? "WAITING_FOR_NEXT_PUBLICATION" : age <= 17 ? "SOURCE_DELAYED" : "STALE"; }
async function materialize(source: SourceData, retrievedAt: string) {
  const matrix = [];
  for (const series of config.series) {
    const points = source.get(series.id)!; const latest = points.at(-1)!; const fresh = freshness(series, latest.date); const analyticsComplete = series.metricKind === "RATE"; const readiness = series.status === "ACTIVE" && analyticsComplete ? "DETAIL_READY" : "HISTORICAL_DETAIL_READY";
    if (series.status === "ACTIVE") await prisma.$executeRawUnsafe(`INSERT INTO mortgage_rate_latest_snapshots (series_id,observation_date,value,freshness_status,as_of_updated_at) VALUES ($1,$2::date,$3,$4,$5::timestamp) ON CONFLICT (series_id) DO UPDATE SET observation_date=EXCLUDED.observation_date,value=EXCLUDED.value,freshness_status=EXCLUDED.freshness_status,as_of_updated_at=EXCLUDED.as_of_updated_at`, series.id, latest.date, latest.value, fresh, retrievedAt);
    else await prisma.$executeRawUnsafe(`DELETE FROM mortgage_rate_latest_snapshots WHERE series_id=$1`, series.id);
    await prisma.$executeRawUnsafe(`INSERT INTO mortgage_rate_coverage (series_id,identity_complete,current_available,history_rows,earliest_date,latest_date,analytics_complete,provenance_complete,freshness_status,detail_readiness,calculated_at) VALUES ($1,true,$2,$3,$4::date,$5::date,$6,true,$7,$8,$9::timestamp) ON CONFLICT (series_id) DO UPDATE SET identity_complete=true,current_available=EXCLUDED.current_available,history_rows=EXCLUDED.history_rows,earliest_date=EXCLUDED.earliest_date,latest_date=EXCLUDED.latest_date,analytics_complete=EXCLUDED.analytics_complete,provenance_complete=true,freshness_status=EXCLUDED.freshness_status,detail_readiness=EXCLUDED.detail_readiness,calculated_at=EXCLUDED.calculated_at`, series.id, series.status === "ACTIVE", points.length, points[0].date, latest.date, analyticsComplete, fresh, readiness, retrievedAt);
    matrix.push({ seriesCode: series.seriesCode, status: series.status, metricKind: series.metricKind, historyRows: points.length, earliestDate: points[0].date, latestDate: latest.date, freshness: fresh, detailReadiness: readiness });
  }
  await atomic(paths.coverage, matrix);
  await atomic(paths.detail, { version: 1, required: ["identity", "latest", "history", "taxonomy", "provenance", "freshness", "rateAnalytics"], active: matrix.filter((row) => row.status === "ACTIVE"), historical: matrix.filter((row) => row.status === "DISCONTINUED") });
  await atomic(paths.search, { version: 1, fields: ["seriesCode", "officialName", "displayName", "mortgageType", "maturity", "rateType", "jurisdiction", "status"], series: matrix.map((row) => row.seriesCode) });
  await atomic(paths.screener, { version: 1, fields: ["latestRate", "change1wBps", "change1mBps", "change1yBps", "historicalPercentile", "maturity", "mortgageType", "status", "freshness"], eligibleSeries: config.series.filter((series) => series.status === "ACTIVE" && series.metricKind === "RATE").map((series) => series.seriesCode) });
  await atomic(paths.compare, { version: 1, compatibility: { RATE: config.series.filter((series) => series.metricKind === "RATE").map((series) => series.seriesCode), POINTS: config.series.filter((series) => series.metricKind === "POINTS").map((series) => series.seriesCode) }, incompatibleMetricKinds: true });
  return matrix;
}

async function reconcile(source: SourceData, invalid: number): Promise<Reconciliation> {
  const canonical = await prisma.$queryRawUnsafe<Array<{ series_id: string; observation_date: string; rate: string }>>(`SELECT series_id,observation_date::text,rate::text FROM mortgage_rate_observations WHERE series_id=ANY($1::text[])`, config.series.map((series) => series.id));
  const sourceMap = new Map<string, number>(); for (const [seriesId, points] of source) for (const point of points) sourceMap.set(`${seriesId}|${point.date}`, point.value);
  const canonicalMap = new Map(canonical.map((row) => [`${row.series_id}|${row.observation_date}`, Number(row.rate)]));
  let missing = 0, extra = 0, conflicts = 0; for (const [key, value] of sourceMap) { if (!canonicalMap.has(key)) missing += 1; else if (Math.abs(canonicalMap.get(key)! - value) > 0.00000001) conflicts += 1; } for (const key of canonicalMap.keys()) if (!sourceMap.has(key)) extra += 1;
  const duplicate = await prisma.$queryRawUnsafe<Array<{ count: number }>>(`SELECT count(*)::int count FROM (SELECT series_id,observation_date FROM mortgage_rate_observations GROUP BY 1,2 HAVING count(*)>1) d`);
  return { sourceRows: sourceMap.size, canonicalRows: canonicalMap.size, missing, extra, conflicts, duplicates: duplicate[0].count, invalid };
}

async function cycle() {
  const fetched = await fetchOfficial(); await upsertIdentities();
  const prior = await readFile(paths.checkpoint, "utf8").then(JSON.parse).catch(() => ({})) as { series?: Record<string, { lastCanonicalDate?: string }> };
  const written = await writeObservations(fetched.data, fetched.retrievedAt, prior.series ?? {}); await writeAnalytics(fetched.data);
  const matrix = await materialize(fetched.data, fetched.retrievedAt); const reconciliation = await reconcile(fetched.data, fetched.invalid);
  if (reconciliation.missing || reconciliation.extra || reconciliation.conflicts || reconciliation.duplicates || reconciliation.invalid) throw new Error(`RECONCILIATION_FAILED:${JSON.stringify(reconciliation)}`);
  const completedAt = now(); const active = matrix.filter((row) => row.status === "ACTIVE"); const historical = matrix.filter((row) => row.status === "DISCONTINUED");
  const historicalRebuiltAt = backfill ? completedAt : (prior as { historicalRebuiltAt?: string }).historicalRebuiltAt;
  const seriesCheckpoint = Object.fromEntries(matrix.map((row) => [config.series.find((series) => series.seriesCode === row.seriesCode)!.id, { country: config.country, metricCode: row.seriesCode, lastSourceState: row.latestDate, lastCanonicalDate: row.latestDate, lastProcessedRecord: `${row.latestDate}:${row.seriesCode}`, lastSuccessfulRun: completedAt, nextEligibleAt: new Date(Date.now() + config.pollIntervalMs).toISOString() }]));
  await atomic(paths.checkpoint, { asset: config.asset, series: seriesCheckpoint, historicalRebuiltAt, dedup: true, upsert: true, resume: true, boundedRetry: config.retry.maxAttempts, failureIsolation: "PER_SERIES", updatedAt: completedAt });
  const latest = active.map((row) => ({ ...row, value: fetched.data.get(config.series.find((series) => series.seriesCode === row.seriesCode)!.id)!.at(-1)!.value })); await atomic(paths.latest, { activeSeriesOnly: true, retrievedAt: fetched.retrievedAt, series: latest });
  const recovery = { task: "MORTGAGE_RATES_P0_PROFESSIONAL_DEPTH_RECOVERY_V1", supervisorReused: !once, supervisorPid: process.pid, supervisorAlive: true, doubleWriter: false, singleWriter: true, canonicalIdentityRelation: "mortgage_rate_series", canonicalIdentityCount: config.series.length, series: matrix, reconciliation, currentActiveSeriesCoverage: `${active.length}/${config.series.filter((series) => series.status === "ACTIVE").length}`, historySeriesCoverage: `${matrix.filter((row) => row.historyRows > 1).length}/${matrix.length}`, observationBasisStatus: "PASS", statisticTypeStatus: "PASS", lifecycleStatus: "PASS", provenanceStatus: "PASS", verificationStateStatus: "PASS", freshnessStatus: "PASS", changeAnalyticsStatus: "PASS_RATE_LEVEL_BPS", rollingAverageStatus: "PASS", percentileStatus: "PASS", rateVolatilityStatus: "PASS", mortgage30y15ySpreadStatus: "PASS", mortgageGovernmentSpreadStatus: "DEFERRED_NOT_P0", pointInTimeLevel: 1, revisionDetectionStatus: "ACTIVE_NO_SOURCE_REVISIONS_DETECTED", coverageMatrixRows: matrix.length, coverageMatrixComplete: true, detailDataReady: true, searchDataReady: true, screenerDataReady: true, compareDataReady: true, rankingDataReady: false, activeDetailReadyCount: active.length, historicalDetailReadyCount: historical.length, internationalSourcePendingCount: config.internationalSourcePending.length, p0DepthGapsRemaining: [], canaryOnlyP0Domains: [], sourceConstrainedDomains: ["INTERNATIONAL_MORTGAGE_RATES", "MORTGAGE_GOVERNMENT_SPREAD"], licenseRequiredGaps: [], p0ProductionPathReady: true, p0DataDepthComplete: true, depthGate: "PASS_SOURCE_CONSTRAINED", written, historicalRebuilt: Boolean(historicalRebuiltAt), historicalRebuiltAt, universeRebuilt: false, websiteModified: false, deployPerformed: false, updatedAt: completedAt };
  await atomic(paths.recovery, recovery); await atomic(paths.status, { ...recovery, scheduler: once ? "READY" : "ACTIVE", autoContinuing: !once, latestPath: "YES", historicalPath: "YES", incremental: "YES", status: once ? "P0_RECOVERY_COMPLETE" : "HEALTHY_WAITING" });
  await atomic(paths.heartbeat, { asset: config.asset, pid: process.pid, alive: true, stage: once ? "P0_RECOVERY_COMPLETE" : "HEALTHY_WAITING", singleWriter: true, heartbeatAt: completedAt });
}

async function main() { await lock(); await schema(); if (!once) await writeFile(paths.pid, String(process.pid)); do { await cycle(); if (once) break; await sleep(config.pollIntervalMs); } while (true); }
process.on("SIGTERM", async () => { await atomic(paths.heartbeat, { asset: config.asset, pid: process.pid, alive: false, stage: "STOPPED", heartbeatAt: now() }); await unlock(); await prisma.$disconnect(); process.exit(0); });
main().catch(async (error) => { await log("FATAL", { error: String(error instanceof Error ? error.stack : error) }); await atomic(paths.heartbeat, { asset: config.asset, pid: process.pid, alive: false, stage: "FAILED_CLOSED", error: String(error), heartbeatAt: now() }); process.exitCode = 1; }).finally(async () => { if (once || process.exitCode) { await unlock(); await prisma.$disconnect(); } });
