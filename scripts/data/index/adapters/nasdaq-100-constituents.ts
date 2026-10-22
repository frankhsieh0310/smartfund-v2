import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const SOURCE_URL = "https://api.nasdaq.com/api/quote/list-type/nasdaq100";
export async function ingestNasdaq100Constituents(prisma: PrismaClient) {
  const response = await fetch(SOURCE_URL, { headers: { "user-agent": "Mozilla/5.0 SmartFund-Global-Index/2.0", accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`NASDAQ_HTTP_${response.status}`);
  const body = await response.json() as any, payload = body?.data, sourceRows = payload?.data?.rows;
  if (!Array.isArray(sourceRows) || sourceRows.length < 90) throw new Error(`NASDAQ_COMPONENTS_INSUFFICIENT:${sourceRows?.length ?? 0}`);
  const asOf = new Date(`${payload.date} 00:00:00 UTC`); if (!Number.isFinite(asOf.getTime())) throw new Error("NASDAQ_AS_OF_INVALID");
  const normalized = sourceRows.flatMap((row: any) => {
    const ticker = String(row.symbol ?? "").trim().toUpperCase(), name = String(row.companyName ?? "").trim();
    return ticker && name ? [{ ticker, name }] : [];
  });
  const tickers = normalized.map(row => row.ticker);
  const candidates = await prisma.$queryRawUnsafe<Array<{ticker:string;security_id:string|null}>>(`SELECT s.ticker,l.security_id FROM stocks s LEFT JOIN stock_security_links l ON l.stock_id=s.id AND l.verification_status ILIKE 'VERIFIED%' WHERE upper(s.ticker)=ANY($1::text[]) AND upper(s.exchange) IN('NASDAQ','XNAS','NASDAQGS','NASDAQGM','NASDAQCM')`, tickers);
  const byTicker = new Map<string,string[]>(); for (const row of candidates) if (row.security_id) byTicker.set(row.ticker.toUpperCase(), [...(byTicker.get(row.ticker.toUpperCase()) ?? []), row.security_id]);
  let written = 0;
  for (const row of normalized) {
    const matches = [...new Set(byTicker.get(row.ticker) ?? [])], securityId = matches.length === 1 ? matches[0] : null;
    written += await prisma.$executeRawUnsafe(`INSERT INTO global_index_constituents(index_id,constituent_key,security_id,constituent_name,ticker,isin,weight,as_of_date,effective_from,effective_to,source,source_record_id,license_status,verification_status,created_at,updated_at) VALUES('nasdaq-100',$1,$2,$3,$1,NULL,NULL,$4,$4,NULL,'NASDAQ_OFFICIAL_API',concat('NASDAQ100:',$4::text,':',$1),'PUBLIC_OFFICIAL',$5,now(),now()) ON CONFLICT(index_id,constituent_key,as_of_date,source) DO UPDATE SET security_id=excluded.security_id,constituent_name=excluded.constituent_name,weight=NULL,verification_status=excluded.verification_status,updated_at=now()`, row.ticker, securityId, row.name, asOf, securityId ? "VERIFIED_EXACT_TICKER_EXCHANGE" : "SOURCE_RAW_ONLY_SECURITY_IDENTITY_PENDING");
  }
  const checksum = createHash("sha256").update(JSON.stringify(normalized.sort((a,b)=>a.ticker.localeCompare(b.ticker)))).digest("hex");
  await prisma.$executeRawUnsafe(`INSERT INTO global_index_coverage(index_id,capability,interval,status,provider,licensing_status,earliest_at,latest_at,row_count,quality_status,details,checked_at) VALUES('nasdaq-100','CURRENT_CONSTITUENTS','', 'PUBLIC_READY','Nasdaq','PUBLIC_OFFICIAL',$1,$1,$2,'PASS',$3::jsonb,now()) ON CONFLICT(index_id,capability,interval) DO UPDATE SET status=excluded.status,provider=excluded.provider,licensing_status=excluded.licensing_status,earliest_at=excluded.earliest_at,latest_at=excluded.latest_at,row_count=excluded.row_count,quality_status=excluded.quality_status,details=excluded.details,checked_at=now()`, asOf, normalized.length, JSON.stringify({snapshotType:"FULL_CURRENT",weightCapability:"SOURCE_NOT_PROVIDED",checksum,sourceUrl:SOURCE_URL,retrievedAt:new Date().toISOString(),parserVersion:"NASDAQ100_API_V1"}));
  const [readback] = await prisma.$queryRawUnsafe<Array<any>>(`SELECT count(*)::int rows,count(*)FILTER(WHERE weight IS NOT NULL)::int weighted,count(*)FILTER(WHERE security_id IS NOT NULL)::int linked,(count(*)-count(DISTINCT constituent_key))::int duplicates,min(as_of_date)::text earliest,max(as_of_date)::text latest FROM global_index_constituents WHERE index_id='nasdaq-100' AND source='NASDAQ_OFFICIAL_API' AND as_of_date=$1`, asOf);
  if (!readback || readback.rows !== normalized.length || readback.duplicates) throw new Error("NASDAQ_COMPONENT_READBACK_FAILED");
  return { indexId:"nasdaq-100", sourceUrl:SOURCE_URL, asOf:asOf.toISOString().slice(0,10), checksum, fetched:normalized.length, written, readback, weightStatus:"SOURCE_NOT_PROVIDED" };
}
