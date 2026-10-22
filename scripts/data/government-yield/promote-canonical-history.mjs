import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve("runtime", "government-yield");
const HISTORY = path.join(ROOT, "serving", "history");
const IDENTITIES = path.join(ROOT, "serving", "identities.json");
const STATE_DIR = path.join(ROOT, "canonical-promotion");
const CHECKPOINT = path.join(STATE_DIR, "checkpoint.json");
const REPORT = path.join(STATE_DIR, "report.json");
const ALLOWED_TENORS = new Map([
  ["1M", 1], ["3M", 3], ["6M", 6], ["1Y", 12], ["2Y", 24],
  ["3Y", 36], ["5Y", 60], ["7Y", 84], ["10Y", 120], ["20Y", 240], ["30Y", 360],
]);
const BATCH_SIZE = 2_000;
const MAX_DB_RETRIES = 3;

function stableUuid(namespace, key) {
  const hex = createHash("sha256").update(`${namespace}:${key}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

async function json(file) { return JSON.parse(await readFile(file, "utf8")); }
async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}
async function priorCheckpoint() {
  try { return await json(CHECKPOINT); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function chunks(rows, size) {
  const result = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}
function curveCode(row) {
  return `${row.country}_${row.curveType}`.replace(/[^A-Z0-9_]/gi, "_").toUpperCase();
}
function curveKey(row) { return `${curveCode(row)}|${row.observationDate}|${row.source}`; }
function scopedWriterDatabaseUrl() {
  // This promotion is the only scoped exception to the normal 6543 pooler path:
  // the configured pooler session is administratively read-only while DIRECT_URL
  // is the existing writable primary. Keep Prisma's direct pool at one connection.
  const raw = process.env.DIRECT_URL;
  if (!raw) throw new Error("DIRECT_URL_REQUIRED_FOR_CURVE_PROMOTION_WRITER");
  const url = new URL(raw);
  if (url.port !== "5432") throw new Error("DIRECT_WRITER_5432_REQUIRED");
  url.searchParams.delete("pgbouncer");
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("connect_timeout", "20");
  return url.toString();
}
async function executeBounded(prisma, sql, params) {
  for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
    try { return await prisma.$executeRawUnsafe(sql, ...params); }
    catch (error) {
      const retryable = /25006|read-only transaction|EMAXCONNSESSION/i.test(String(error?.message ?? error));
      if (!retryable || attempt === MAX_DB_RETRIES) throw error;
      await prisma.$disconnect();
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      await prisma.$connect();
    }
  }
  throw new Error("UNREACHABLE_DB_RETRY_STATE");
}

async function insertCurves(prisma, rows) {
  const unique = [...new Map(rows.map((row) => [curveKey(row), row])).values()];
  let inserted = 0;
  for (const batch of chunks(unique, BATCH_SIZE)) {
    const params = [];
    const values = batch.map((row) => {
      const key = curveKey(row);
      const offset = params.length;
      params.push(stableUuid("government-yield-curve", key), curveCode(row), row.country, row.currency, row.curveType, row.observationDate, row.source);
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6}::date,$${offset + 7})`;
    });
    inserted += await executeBounded(prisma,
      `INSERT INTO yield_curves (id,curve_code,country,currency,curve_type,curve_date,source) VALUES ${values.join(",")} ON CONFLICT (curve_code,curve_date,source) DO NOTHING`,
      params,
    );
  }
  return inserted;
}

async function insertPoints(prisma, rows) {
  let inserted = 0;
  for (const batch of chunks(rows, BATCH_SIZE)) {
    const params = [];
    const values = batch.map((row) => {
      const cKey = curveKey(row);
      const curveId = stableUuid("government-yield-curve", cKey);
      const pointId = stableUuid("government-yield-point", `${cKey}|${row.tenor}`);
      const offset = params.length;
      params.push(pointId, curveId, row.tenor, ALLOWED_TENORS.get(row.tenor), String(row.value), row.observationDate, row.seriesId);
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4}::int,$${offset + 5}::numeric,$${offset + 6}::date,$${offset + 7})`;
    });
    inserted += await executeBounded(prisma,
      `INSERT INTO yield_curve_points (id,curve_id,tenor,tenor_months,yield,observation_date,source_series) VALUES ${values.join(",")} ON CONFLICT (curve_id,tenor) DO NOTHING`,
      params,
    );
  }
  return inserted;
}

async function main() {
  const startedAt = new Date().toISOString();
  const identityDoc = await json(IDENTITIES);
  const identities = new Map(identityDoc.rows.map((row) => [row.canonicalId, row]));
  const files = (await readdir(HISTORY)).filter((file) => file.endsWith(".json")).sort();
  const prior = await priorCheckpoint();
  const completed = new Set(prior?.sourceFingerprint === "OFFICIAL_57_SERIES_373907" && prior?.state !== "COMPLETE" ? prior.completedSeries ?? [] : []);
  const counters = prior?.sourceFingerprint === "OFFICIAL_57_SERIES_373907" && prior?.state !== "COMPLETE"
    ? { ...prior.counters }
    : { sourceRows: 0, eligibleRows: 0, promotedRows: 0, skippedDuplicates: 0, tenorMappingPending: 0, countryMappingPending: 0, invalidRows: 0, orphanSeries: 0 };
  const prisma = new PrismaClient({ datasources: { db: { url: scopedWriterDatabaseUrl() } } });
  await atomic(CHECKPOINT, { version: 1, state: "RUNNING", sourceFingerprint: "OFFICIAL_57_SERIES_373907", maxDbConcurrency: 1, maxDbRetries: MAX_DB_RETRIES, batchSize: BATCH_SIZE, startedAt: prior?.startedAt ?? startedAt, updatedAt: startedAt, completedSeries: [...completed], counters });

  try {
    for (const file of files) {
      const document = await json(path.join(HISTORY, file));
      if (completed.has(document.canonicalId)) continue;
      const identity = identities.get(document.canonicalId);
      const rows = document.rows ?? [];
      const delta = { sourceRows: rows.length, eligibleRows: 0, promotedRows: 0, skippedDuplicates: 0, tenorMappingPending: 0, countryMappingPending: 0, invalidRows: 0, orphanSeries: 0 };
      if (!identity) {
        delta.orphanSeries += rows.length;
        delta.countryMappingPending += rows.length;
      } else {
        const eligible = [];
        for (const row of rows) {
          if (!ALLOWED_TENORS.has(row.tenor)) { delta.tenorMappingPending++; continue; }
          if (row.country !== identity.jurisdictionCode || !identity.currency) { delta.countryMappingPending++; continue; }
          if (!Number.isFinite(row.value) || !/^\d{4}-\d{2}-\d{2}$/.test(row.observationDate) || row.observationDate > new Date().toISOString().slice(0, 10)) { delta.invalidRows++; continue; }
          eligible.push({ ...row, currency: identity.currency });
        }
        delta.eligibleRows += eligible.length;
        await insertCurves(prisma, eligible);
        const promoted = await insertPoints(prisma, eligible);
        delta.promotedRows += promoted;
        delta.skippedDuplicates += eligible.length - promoted;
      }
      for (const key of Object.keys(delta)) counters[key] += delta[key];
      completed.add(document.canonicalId);
      await atomic(CHECKPOINT, { version: 1, state: "RUNNING", sourceFingerprint: "OFFICIAL_57_SERIES_373907", maxDbConcurrency: 1, batchSize: BATCH_SIZE, startedAt: prior?.startedAt ?? startedAt, updatedAt: new Date().toISOString(), lastCompletedSeries: document.canonicalId, completedSeries: [...completed], counters });
      console.log(JSON.stringify({ series: document.canonicalId, completed: completed.size, total: files.length, ...counters }));
    }

    const summary = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS rows,
             COUNT(DISTINCT yc.country)::int AS countries,
             COUNT(DISTINCT ycp.tenor)::int AS tenors
      FROM yield_curve_points ycp JOIN yield_curves yc ON yc.id=ycp.curve_id`);
    const breakdown = await prisma.$queryRawUnsafe(`
      SELECT yc.country, COUNT(DISTINCT ycp.source_series)::int AS series,
             COUNT(DISTINCT ycp.tenor)::int AS tenors, COUNT(*)::int AS rows,
             MIN(ycp.observation_date)::text AS earliest, MAX(ycp.observation_date)::text AS latest
      FROM yield_curve_points ycp JOIN yield_curves yc ON yc.id=ycp.curve_id
      GROUP BY yc.country ORDER BY yc.country`);
    const quality = await prisma.$queryRawUnsafe(`
      SELECT
        (SELECT COUNT(*)::int FROM (SELECT curve_id,tenor,COUNT(*) FROM yield_curve_points GROUP BY curve_id,tenor HAVING COUNT(*)>1) d) AS duplicates,
        (SELECT COUNT(*)::int FROM yield_curve_points WHERE yield IS NULL OR observation_date>CURRENT_DATE) AS invalid,
        (SELECT COUNT(*)::int FROM yield_curve_points p LEFT JOIN yield_curves c ON c.id=p.curve_id WHERE c.id IS NULL) AS orphans`);
    const readiness = await prisma.$queryRawUnsafe(`
      SELECT country,
        BOOL_OR(has_2y AND has_10y) AS "2s10s",
        BOOL_OR(has_2y AND has_30y) AS "2s30s",
        BOOL_OR(has_5y AND has_30y) AS "5s30s",
        BOOL_OR(has_3m AND has_10y) AS "3m10y"
      FROM (
        SELECT yc.country,yc.curve_type,yc.curve_date,yc.source,
          BOOL_OR(p.tenor='2Y') has_2y, BOOL_OR(p.tenor='5Y') has_5y,
          BOOL_OR(p.tenor='10Y') has_10y, BOOL_OR(p.tenor='30Y') has_30y,
          BOOL_OR(p.tenor='3M') has_3m
        FROM yield_curves yc JOIN yield_curve_points p ON p.curve_id=yc.id
        GROUP BY yc.country,yc.curve_type,yc.curve_date,yc.source
      ) q GROUP BY country ORDER BY country`);
    const report = { status: quality[0].duplicates === 0 && quality[0].invalid === 0 && quality[0].orphans === 0 ? "PASS" : "FAIL", sourceSeries: files.length, ...counters, canonicalAfter: summary[0], countryBreakdown: breakdown, quality: quality[0], derivedCurveReadiness: readiness, completedAt: new Date().toISOString() };
    await atomic(REPORT, report);
    await atomic(CHECKPOINT, { version: 1, state: "COMPLETE", sourceFingerprint: "OFFICIAL_57_SERIES_373907", maxDbConcurrency: 1, batchSize: BATCH_SIZE, startedAt: prior?.startedAt ?? startedAt, updatedAt: report.completedAt, completedAt: report.completedAt, lastCompletedSeries: files.at(-1), completedSeries: [...completed], counters });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await atomic(CHECKPOINT, { version: 1, state: "BLOCKED", sourceFingerprint: "OFFICIAL_57_SERIES_373907", maxDbConcurrency: 1, batchSize: BATCH_SIZE, startedAt: prior?.startedAt ?? startedAt, updatedAt: new Date().toISOString(), completedSeries: [...completed], counters, lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
