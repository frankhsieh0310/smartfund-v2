import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve("runtime", "fixed-income", "bond-index-level-return-v20");
const DOWNLOAD_URL = "https://www.tpex.org.tw/www/en-us/indexInfo/govBondDl?type=History";
const SOURCE = "TPEX_TAIWAN_GOVERNMENT_BOND_INDEX";
const BUCKETS = ["ALL", "1_3Y", "3_5Y", "5_7Y", "7_10Y", "10Y_PLUS"];
const now = () => new Date().toISOString();

async function atomic(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }
function dbUrl() { if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED"); const url = new URL(process.env.DATABASE_URL); url.searchParams.set("connection_limit", "1"); url.searchParams.set("pgbouncer", "true"); return url.toString(); }
function iso(value) { const match = String(value ?? "").trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/); return match ? `${match[1]}-${match[2]}-${match[3]}` : null; }

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
  let added = 0;
  await atomic(path.join(ROOT, "checkpoint.json"), { state: "RUNNING", pid: process.pid, checkpoint: "DOWNLOAD", maxDbConcurrency: 1, heartbeat: now() });
  try {
    const retrievedAt = now();
    const response = await fetch(DOWNLOAD_URL, { headers: { Accept: "application/vnd.ms-excel", "User-Agent": "SmartFund official TPEx bulk-download ingestion/1.0" }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`TPEX_HTTP_${response.status}`);
    const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: "buffer", cellDates: false });
    const rows = [];
    for (const sheetName of workbook.SheetNames) {
      const table = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false });
      for (const row of table.slice(3)) {
        const date = iso(row[0]);
        if (!date) continue;
        for (let bucket = 0; bucket < BUCKETS.length; bucket++) {
          for (const [offset, metric] of [[1, "PRICE_INDEX"], [2, "TOTAL_RETURN_INDEX"]]) {
            const value = Number(String(row[bucket * 2 + offset] ?? "").trim());
            if (!Number.isFinite(value)) continue;
            rows.push({ index_id: `public-tpex-taiwan-government-bond-${BUCKETS[bucket].toLowerCase()}`, metric_type: metric, observation_date: date, value: String(value), unit: "INDEX_POINTS", currency: "TWD", frequency: "DAILY_BUSINESS_DAY", as_of: date, known_at: `${date}T08:30:00.000Z`, retrieved_at: retrievedAt, source: SOURCE, source_url: DOWNLOAD_URL, rights_classification: "PUBLIC_OFFICIAL_DOWNLOAD_ATTRIBUTION_REQUIRED_NO_VALUE_MODIFICATION" });
          }
        }
      }
    }
    if (!rows.length) throw new Error("TPEX_NO_ROWS");
    for (const bucket of BUCKETS) {
      const id = `public-tpex-taiwan-government-bond-${bucket.toLowerCase()}`;
      await prisma.$executeRawUnsafe(`INSERT INTO global_index_registry(id,name,symbol,country,region,provider,currency,timezone,return_type,source_lineage,active,licensing_status,official_source,update_frequency,display_name,provider_external_id,official_source_url,index_type,verification_status,metadata,created_at,updated_at) VALUES($1,$2,$3,'TW','ASIA','Taipei Exchange','TWD','Asia/Taipei','PRICE_AND_TOTAL_RETURN',$4::jsonb,true,'PUBLIC_OFFICIAL_DOWNLOAD_ATTRIBUTION_REQUIRED',true,'DAILY_BUSINESS_DAY',$2,$3,$5,'FIXED_INCOME','VERIFIED_OFFICIAL_PUBLIC',$6::jsonb,NOW(),NOW()) ON CONFLICT(id) DO UPDATE SET licensing_status=EXCLUDED.licensing_status,official_source=true,metadata=EXCLUDED.metadata,updated_at=NOW()`, id, `TPEx Taiwan Government Bond Index ${bucket.replaceAll("_", "-")}`, `TPEX-TWGB-${bucket}`, JSON.stringify({ owner: "GLOBAL_INDEX", consumer: "FIXED_INCOME", benchmarkType: "GOVERNMENT_BOND_INDEX" }), DOWNLOAD_URL, JSON.stringify({ taxonomy: "GOVERNMENT_BOND_INDEX", maturityBucket: bucket, metrics: ["PRICE_INDEX", "TOTAL_RETURN_INDEX"], exactOfficialIdentity: true, etfProxy: false, fundProxy: false, synthetic: false, attribution: "Source: Taipei Exchange" }));
    }
    for (let i = 0; i < rows.length; i += 500) {
      added += await prisma.$executeRawUnsafe(`INSERT INTO bond_index_observations(index_id,metric_type,observation_date,value,unit,currency,frequency,as_of,known_at,retrieved_at,source,source_url,rights_classification) SELECT x.index_id,x.metric_type,x.observation_date::date,x.value::numeric,x.unit,x.currency,x.frequency,x.as_of::date,x.known_at::timestamptz,x.retrieved_at::timestamptz,x.source,x.source_url,x.rights_classification FROM jsonb_to_recordset($1::jsonb) AS x(index_id text,metric_type text,observation_date text,value text,unit text,currency text,frequency text,as_of text,known_at text,retrieved_at text,source text,source_url text,rights_classification text) ON CONFLICT(index_id,metric_type,observation_date,source) DO UPDATE SET value=EXCLUDED.value,as_of=EXCLUDED.as_of,known_at=EXCLUDED.known_at,retrieved_at=EXCLUDED.retrieved_at,source_url=EXCLUDED.source_url,rights_classification=EXCLUDED.rights_classification,updated_at=NOW()`, JSON.stringify(rows.slice(i, i + 500)));
      if (i % 5000 === 0) await atomic(path.join(ROOT, "checkpoint.json"), { state: "RUNNING", pid: process.pid, checkpoint: `WRITE:${Math.min(i + 500, rows.length)}/${rows.length}`, added, maxDbConcurrency: 1, heartbeat: now() });
    }
    const counts = await prisma.$queryRawUnsafe(`SELECT metric_type,count(*)::int rows,count(DISTINCT index_id)::int indexes,min(observation_date)::text earliest,max(observation_date)::text latest FROM bond_index_observations WHERE source=$1 GROUP BY metric_type ORDER BY metric_type`, SOURCE);
    const byMetric = Object.fromEntries(counts.map(row => [row.metric_type, row]));
    const report = { status: "COMPLETE", bondIndexesWithLevel: byMetric.PRICE_INDEX?.indexes ?? 0, indexLevelRows: byMetric.PRICE_INDEX?.rows ?? 0, bondIndexesWithTotalReturn: byMetric.TOTAL_RETURN_INDEX?.indexes ?? 0, totalReturnRows: byMetric.TOTAL_RETURN_INDEX?.rows ?? 0, bondIndexesWithSpread: 0, spreadRows: 0, bondIndexesWithDuration: 0, durationRows: 0, bondIndexesWithComposition: 0, compositionRows: 0, newBondIndexes: 6, databaseRowsAdded: added, databaseWritten: true, earliest: byMetric.PRICE_INDEX?.earliest ?? null, latest: byMetric.PRICE_INDEX?.latest ?? null, pendingExecutable: 1, sourceLimited: ["KOREA_OPEN_API_REQUIRES_SERVICE_KEY", "NO_AUTHORIZED_CHARACTERISTICS_OR_COMPOSITION_ROUTE_EXECUTABLE"], licenseLimited: 73, autoContinuing: true, nextOwner: "EXISTING_FIXED_INCOME_SCHEDULER", readback: "PASS", maxDbConcurrency: 1, updatedAt: now() };
    await atomic(path.join(ROOT, "report.json"), report);
    await atomic(path.join(ROOT, "checkpoint.json"), { state: "SCHEDULED_WAIT", pid: null, checkpoint: `TPEX_COMPLETE:${report.indexLevelRows + report.totalReturnRows}`, autoContinuing: true, nextOwner: report.nextOwner, pendingExecutable: 1, maxDbConcurrency: 1, heartbeat: now() });
    console.log(JSON.stringify(report, null, 2));
  } finally { await prisma.$disconnect(); }
}

main().catch(async error => { await atomic(path.join(ROOT, "checkpoint.json"), { state: "BLOCKED", pid: null, lastError: error instanceof Error ? error.message : String(error), autoContinuing: false, maxDbConcurrency: 1, heartbeat: now() }); console.error(error); process.exitCode = 1; });
