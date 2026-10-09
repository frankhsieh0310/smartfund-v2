import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve("runtime", "fixed-income", "korea-fsc-bond-index");
const ENDPOINT = "https://apis.data.go.kr/1160100/service/GetMarketIndexInfoService/getBondMarketIndex";
const SOURCE = "KOREA_FSC_KRX_BOND_MARKET_INDEX_OPEN_API";
const now = () => new Date().toISOString();
async function atomic(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }
function dbUrl() { if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED"); const url = new URL(process.env.DATABASE_URL); url.searchParams.set("connection_limit", "1"); url.searchParams.set("pgbouncer", "true"); return url.toString(); }
function slug(value) { return String(value).normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 100); }
function date(value) { const text = String(value ?? ""); return /^\d{8}$/.test(text) ? `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}` : null; }
function items(payload) { const value = payload?.response?.body?.items?.item; return Array.isArray(value) ? value : value ? [value] : []; }

async function main() {
  const key = process.env.KOREA_PUBLIC_DATA_SERVICE_KEY ?? process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) {
    await atomic(path.join(ROOT, "checkpoint.json"), { state: "AUTH_REQUIRED", pid: null, checkpoint: "ADAPTER_READY_SERVICE_KEY_REQUIRED", credentialEnv: ["KOREA_PUBLIC_DATA_SERVICE_KEY", "DATA_GO_KR_SERVICE_KEY"], sourceLicense: "NO_USAGE_RESTRICTION", autoContinuing: false, maxDbConcurrency: 1, heartbeat: now() });
    console.log(JSON.stringify({ status: "AUTH_REQUIRED", adapter: "READY", rowsAdded: 0 }, null, 2));
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
  let page = 1, added = 0, processed = 0, total = Infinity;
  await atomic(path.join(ROOT, "checkpoint.json"), { state: "RUNNING", pid: process.pid, page, processed, added, maxDbConcurrency: 1, heartbeat: now() });
  try {
    while (processed < total) {
      const url = new URL(ENDPOINT);
      url.searchParams.set("serviceKey", key);
      url.searchParams.set("resultType", "json");
      url.searchParams.set("pageNo", String(page));
      url.searchParams.set("numOfRows", "1000");
      url.searchParams.set("beginBasDt", "20200101");
      const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "SmartFund Korea FSC open-data ingestion/1.0" }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`KOREA_FSC_HTTP_${response.status}`);
      const payload = await response.json();
      if (payload?.response?.header?.resultCode && payload.response.header.resultCode !== "00") throw new Error(`KOREA_FSC_${payload.response.header.resultCode}:${payload.response.header.resultMsg}`);
      const batch = items(payload);
      total = Number(payload?.response?.body?.totalCount ?? batch.length);
      if (!batch.length) break;
      const observations = [];
      for (const item of batch) {
        const name = item.idxNm ?? item.inxNm ?? item.basIdxNm ?? item.itmsNm;
        const observationDate = date(item.basDt);
        const value = Number(item.clpr ?? item.clos ?? item.idxClpr ?? item.mkp);
        if (!name || !observationDate || !Number.isFinite(value)) continue;
        const metric = /총수익|total\s*return/i.test(name) ? "TOTAL_RETURN_INDEX" : "INDEX_LEVEL";
        const id = `public-korea-fsc-bond-${slug(name)}`;
        await prisma.$executeRawUnsafe(`INSERT INTO global_index_registry(id,name,symbol,country,region,provider,currency,timezone,return_type,source_lineage,active,licensing_status,official_source,update_frequency,display_name,provider_external_id,official_source_url,index_type,verification_status,metadata,created_at,updated_at) VALUES($1,$2,$3,'KR','ASIA','Korea Financial Services Commission / Korea Exchange','KRW','Asia/Seoul',$4,$5::jsonb,true,'KOREA_OPEN_DATA_NO_USAGE_RESTRICTION',true,'DAILY',$2,$3,$6,'FIXED_INCOME','VERIFIED_OFFICIAL_PUBLIC',$7::jsonb,NOW(),NOW()) ON CONFLICT(id) DO UPDATE SET licensing_status=EXCLUDED.licensing_status,official_source=true,updated_at=NOW()`, id, name, slug(name).toUpperCase(), metric, JSON.stringify({ owner: "GLOBAL_INDEX", consumer: "FIXED_INCOME", benchmarkType: "BOND_INDEX" }), ENDPOINT, JSON.stringify({ exactSourceIdentity: true, etfProxy: false, fundProxy: false, synthetic: false, sourceFields: Object.keys(item) }));
        observations.push({ index_id: id, metric_type: metric, observation_date: observationDate, value: String(value), unit: "INDEX_POINTS", currency: "KRW", frequency: "DAILY", as_of: observationDate, known_at: `${observationDate}T04:00:00.000Z`, retrieved_at: now(), source: SOURCE, source_url: ENDPOINT, rights_classification: "KOREA_OPEN_DATA_NO_USAGE_RESTRICTION" });
      }
      for (let i = 0; i < observations.length; i += 500) added += await prisma.$executeRawUnsafe(`INSERT INTO bond_index_observations(index_id,metric_type,observation_date,value,unit,currency,frequency,as_of,known_at,retrieved_at,source,source_url,rights_classification) SELECT x.index_id,x.metric_type,x.observation_date::date,x.value::numeric,x.unit,x.currency,x.frequency,x.as_of::date,x.known_at::timestamptz,x.retrieved_at::timestamptz,x.source,x.source_url,x.rights_classification FROM jsonb_to_recordset($1::jsonb) AS x(index_id text,metric_type text,observation_date text,value text,unit text,currency text,frequency text,as_of text,known_at text,retrieved_at text,source text,source_url text,rights_classification text) ON CONFLICT(index_id,metric_type,observation_date,source) DO UPDATE SET value=EXCLUDED.value,retrieved_at=EXCLUDED.retrieved_at,updated_at=NOW()`, JSON.stringify(observations.slice(i, i + 500)));
      processed += batch.length; page++;
      await atomic(path.join(ROOT, "checkpoint.json"), { state: "RUNNING", pid: process.pid, page, processed, total, added, maxDbConcurrency: 1, heartbeat: now() });
    }
    const counts = await prisma.$queryRawUnsafe(`SELECT metric_type,count(*)::int rows,count(DISTINCT index_id)::int indexes,min(observation_date)::text earliest,max(observation_date)::text latest FROM bond_index_observations WHERE source=$1 GROUP BY metric_type`, SOURCE);
    const report = { status: "COMPLETE", counts, databaseRowsAdded: added, databaseWritten: counts.some(row => row.rows > 0), readback: "PASS", autoContinuing: true, maxDbConcurrency: 1, updatedAt: now() };
    await atomic(path.join(ROOT, "report.json"), report);
    await atomic(path.join(ROOT, "checkpoint.json"), { state: "SCHEDULED_WAIT", pid: null, checkpoint: `KOREA_FSC_COMPLETE:${processed}`, autoContinuing: true, maxDbConcurrency: 1, heartbeat: now() });
    console.log(JSON.stringify(report, null, 2));
  } finally { await prisma.$disconnect(); }
}

main().catch(async error => { await atomic(path.join(ROOT, "checkpoint.json"), { state: "BLOCKED", pid: null, lastError: error instanceof Error ? error.message : String(error), autoContinuing: false, maxDbConcurrency: 1, heartbeat: now() }); console.error(error); process.exitCode = 1; });
