import { readFile, rename, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const SERIES_ID = "DTWEXBGS";
const SOURCE_URL = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${SERIES_ID}`;

function parse(csv: string) {
  return csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).slice(1).flatMap(line => {
    const [date, raw] = line.split(","); const value = Number(raw);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) && value > 0 ? [{ date, value }] : [];
  });
}

export async function ingestFredBroadDollar(prisma: PrismaClient) {
  const response = await fetch(SOURCE_URL, { headers: { "user-agent": "SmartFund-Global-Index/2.0" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`FRED_HTTP_${response.status}`);
  const rows = parse(await response.text()); if (rows.length < 100) throw new Error(`FRED_SERIES_INSUFFICIENT:${rows.length}`);
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += 250) {
    const batch = rows.slice(offset, offset + 250);
    written += await prisma.$executeRawUnsafe(`INSERT INTO global_index_daily_observations(index_id,observation_date,value,open,high,low,source,source_type,source_record_id,source_url,as_of_date,ingested_at,verification_status,quality_status,license_status,value_shape) SELECT 'broad-dollar-index',x.date,x.value,NULL,NULL,NULL,'FEDERAL_RESERVE_FRED','OFFICIAL',concat($2,':',x.date),$3,x.date,now(),'VERIFIED_OFFICIAL_SERIES','PASS','PUBLIC_OFFICIAL','CLOSE_ONLY' FROM jsonb_to_recordset($1::jsonb)x(date date,value numeric) ON CONFLICT(index_id,observation_date,source) DO UPDATE SET value=excluded.value,as_of_date=excluded.as_of_date,ingested_at=now(),quality_status='PASS'`, JSON.stringify(batch), SERIES_ID, SOURCE_URL);
  }
  await prisma.$executeRawUnsafe(`UPDATE global_index_registry SET provider_external_id=$2,official_source_url=$3,official_source=true,verification_status='VERIFIED_OFFICIAL_SERIES',licensing_status='PUBLIC_OFFICIAL',update_frequency='DAILY_BUSINESS',source_lineage=jsonb_build_object('source','Board of Governors of the Federal Reserve System via FRED','seriesId',$2,'title','Nominal Broad U.S. Dollar Index','units','Index Jan 2006=100','frequency','Daily','seasonalAdjustment','Not Seasonally Adjusted','url',$3),updated_at=now() WHERE id=$1`, "broad-dollar-index", SERIES_ID, SOURCE_URL);
  const [readback] = await prisma.$queryRawUnsafe<Array<any>>(`SELECT count(*)::int rows,min(observation_date)::text earliest,max(observation_date)::text latest,(count(*)-count(DISTINCT observation_date))::int duplicates,count(*) FILTER(WHERE observation_date>current_date)::int future FROM global_index_daily_observations WHERE index_id='broad-dollar-index' AND source='FEDERAL_RESERVE_FRED'`);
  if (!readback || readback.rows < 100 || readback.duplicates || readback.future) throw new Error("FRED_CANONICAL_READBACK_FAILED");
  const queuePath = "runtime/index/history-route-queue.json", queue = JSON.parse(await readFile(queuePath, "utf8"));
  const item = queue.items.find((entry: any) => entry.id === "broad-dollar-index");
  if (item) Object.assign(item, { status: "PUBLIC_ADAPTER_ACTIVE", reason: "OFFICIAL_FRED_DTWEXBGS_CLOSE_ONLY", sourceAdapter: "FRED_CSV", checkpoint: readback.latest, attempts: Number(item.attempts ?? 0) + 1, updatedAt: new Date().toISOString() });
  queue.updatedAt = new Date().toISOString(); const temporary = `${queuePath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(queue, null, 2)}\n`); await rename(temporary, queuePath);
  return { seriesId: SERIES_ID, title: "Nominal Broad U.S. Dollar Index", units: "Index Jan 2006=100", frequency: "Daily", seasonalAdjustment: "Not Seasonally Adjusted", sourceUrl: SOURCE_URL, fetched: rows.length, written, readback };
}
