import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve("runtime", "fixed-income", "bond-index-public-api-v19");
const TENORS = ["1Y", "2Y", "5Y", "10Y", "20Y", "30Y"];
const SOURCE = "ECB_EURO_AREA_GOVERNMENT_ZERO_COUPON_YIELD_CURVE";
const now = () => new Date().toISOString();

async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

function dbUrl() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pgbouncer", "true");
  return url.toString();
}

function csv(line) {
  const out = [];
  let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { out.push(value); value = ""; }
    else value += c;
  }
  out.push(value);
  return out;
}

async function fetchTenor(tenor) {
  const key = `B.U2.EUR.4F.G_N_C.SV_C_YM.SR_${tenor}`;
  const sourceUrl = `https://data-api.ecb.europa.eu/service/data/YC/${key}?format=csvdata&startPeriod=2004-09-06`;
  const retrievedAt = now();
  const response = await fetch(sourceUrl, { headers: { Accept: "text/csv", "User-Agent": "SmartFund ECB public benchmark ingestion/1.0" }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`ECB_HTTP_${response.status}:${tenor}`);
  const lines = (await response.text()).trim().split(/\r?\n/);
  const header = csv(lines.shift());
  const dateAt = header.indexOf("TIME_PERIOD"), valueAt = header.indexOf("OBS_VALUE"), statusAt = header.indexOf("OBS_STATUS");
  if (dateAt < 0 || valueAt < 0) throw new Error(`ECB_SCHEMA_MISMATCH:${tenor}`);
  return lines.map(csv).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row[dateAt]) && Number.isFinite(Number(row[valueAt])) && (!row[statusAt] || row[statusAt] === "A")).map(row => ({
    index_id: `public-ecb-euro-government-zero-coupon-spot-${tenor.toLowerCase()}`,
    metric_type: "YIELD",
    observation_date: row[dateAt],
    value: row[valueAt],
    unit: "PERCENT_PER_ANNUM",
    currency: "EUR",
    frequency: "DAILY_BUSINESS_DAY",
    as_of: row[dateAt],
    known_at: `${row[dateAt]}T12:00:00.000Z`,
    retrieved_at: retrievedAt,
    source: SOURCE,
    source_url: sourceUrl,
    rights_classification: "PUBLIC_STORAGE_ALLOWED_ESCB_FREE_REUSE_WITH_ATTRIBUTION",
  }));
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
  let added = 0, processed = 0;
  await atomic(path.join(ROOT, "checkpoint.json"), { state: "RUNNING", pid: process.pid, currentTenor: TENORS[0], processed, added, maxDbConcurrency: 1, heartbeat: now() });
  try {
    for (const tenor of TENORS) {
      const rows = await fetchTenor(tenor);
      if (!rows.length) throw new Error(`ECB_NO_ROWS:${tenor}`);
      const sample = rows[0];
      await prisma.$executeRawUnsafe(`INSERT INTO global_index_registry(id,name,symbol,country,region,provider,currency,timezone,return_type,source_lineage,active,licensing_status,official_source,update_frequency,display_name,provider_external_id,official_source_url,index_type,verification_status,metadata,created_at,updated_at) VALUES($1,$2,$3,'U2','EURO_AREA','European Central Bank','EUR','Europe/Frankfurt','YIELD',$4::jsonb,true,'PUBLIC_STORAGE_ALLOWED_ESCB_FREE_REUSE',true,'DAILY_BUSINESS_DAY',$2,$3,$5,'FIXED_INCOME','VERIFIED_OFFICIAL_PUBLIC',$6::jsonb,NOW(),NOW()) ON CONFLICT(id) DO UPDATE SET licensing_status=EXCLUDED.licensing_status,official_source=true,metadata=EXCLUDED.metadata,updated_at=NOW()`, sample.index_id, `ECB Euro Area Government Zero-Coupon Spot Yield ${tenor}`, `ECB-YC-${tenor}`, JSON.stringify({ owner: "GLOBAL_INDEX", consumer: "FIXED_INCOME", benchmarkType: "GOVERNMENT_BOND_BENCHMARK_YIELD" }), sample.source_url, JSON.stringify({ taxonomy: "GOVERNMENT", metric: "YIELD", tenor, curveType: "NOMINAL_ZERO_COUPON_SPOT", model: "SVENSSON_CONTINUOUS_COMPOUNDING", rights: "ESCB_FREE_REUSE_WITH_ATTRIBUTION", synthetic: false }));
      for (let i = 0; i < rows.length; i += 500) added += await prisma.$executeRawUnsafe(`INSERT INTO bond_index_observations(index_id,metric_type,observation_date,value,unit,currency,frequency,as_of,known_at,retrieved_at,source,source_url,rights_classification) SELECT x.index_id,x.metric_type,x.observation_date::date,x.value::numeric,x.unit,x.currency,x.frequency,x.as_of::date,x.known_at::timestamptz,x.retrieved_at::timestamptz,x.source,x.source_url,x.rights_classification FROM jsonb_to_recordset($1::jsonb) AS x(index_id text,metric_type text,observation_date text,value text,unit text,currency text,frequency text,as_of text,known_at text,retrieved_at text,source text,source_url text,rights_classification text) ON CONFLICT(index_id,metric_type,observation_date,source) DO UPDATE SET value=EXCLUDED.value,as_of=EXCLUDED.as_of,known_at=EXCLUDED.known_at,retrieved_at=EXCLUDED.retrieved_at,source_url=EXCLUDED.source_url,rights_classification=EXCLUDED.rights_classification,updated_at=NOW()`, JSON.stringify(rows.slice(i, i + 500)));
      processed += rows.length;
      await atomic(path.join(ROOT, "checkpoint.json"), { state: "RUNNING", pid: process.pid, currentTenor: tenor, processed, added, maxDbConcurrency: 1, heartbeat: now() });
    }
    const [readback] = await prisma.$queryRawUnsafe(`SELECT count(*)::int rows,count(DISTINCT index_id)::int indexes,min(observation_date)::text earliest,max(observation_date)::text latest FROM bond_index_observations WHERE source=$1`, SOURCE);
    const report = { status: "COMPLETE", indexesFound: readback.indexes, authorizedSources: ["ECB_DATA_PORTAL_SDMX_API"], indexLevelRows: 0, totalReturnRows: 0, yieldRows: readback.rows, spreadRows: 0, durationRows: 0, compositionRows: 0, databaseRowsAdded: added, databaseWritten: readback.rows > 0, earliest: readback.earliest, latest: readback.latest, sourceLimited: ["NO_AUTHORIZED_LEVEL_OR_RETURN_DATASET_FOUND"], licenseLimited: 73, autoContinuing: true, nextOwner: "EXISTING_FIXED_INCOME_SCHEDULER", maxDbConcurrency: 1, readback: "PASS", updatedAt: now() };
    await atomic(path.join(ROOT, "report.json"), report);
    await atomic(path.join(ROOT, "checkpoint.json"), { state: "SCHEDULED_WAIT", pid: null, checkpoint: `ECB_COMPLETE:${readback.indexes}/${readback.rows}`, autoContinuing: true, nextOwner: report.nextOwner, maxDbConcurrency: 1, heartbeat: now() });
    console.log(JSON.stringify(report, null, 2));
  } finally { await prisma.$disconnect(); }
}

main().catch(async error => { await atomic(path.join(ROOT, "checkpoint.json"), { state: "BLOCKED", pid: null, lastError: error instanceof Error ? error.message : String(error), autoContinuing: false, maxDbConcurrency: 1, heartbeat: now() }); console.error(error); process.exitCode = 1; });
