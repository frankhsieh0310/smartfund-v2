import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root=process.cwd(),rawDir=path.join(root,"runtime","etf-yahoo-product-modules","raw");
const engine=path.resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if(process.platform==="win32"&&!process.env.PRISMA_QUERY_ENGINE_LIBRARY)process.env.PRISMA_QUERY_ENGINE_LIBRARY=engine;
const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}});
const limit=Number(process.argv.find(x=>x.startsWith("--limit="))?.slice(8)??"500");
const pct=(x:any)=>{const v=x&&typeof x==="object"?x.raw:x;return typeof v==="number"&&Number.isFinite(v)?(Math.abs(v)<=2?v*100:v):null};

async function main(){
 const latest=new Map<string,{file:string,artifact:any,rows:any[]}>();
 for(const file of await fs.readdir(rawDir)){
  if(!file.endsWith(".json"))continue;const id=file.slice(0,36);if(!/^[0-9a-f-]{36}$/i.test(id))continue;
  const artifact=JSON.parse(await fs.readFile(path.join(rawDir,file),"utf8")),holdings=artifact?.payload?.quoteSummary?.result?.[0]?.topHoldings?.holdings;
  if(!Array.isArray(holdings)||!holdings.length)continue;const prior=latest.get(id);if(!prior||String(artifact.retrievedAt)>String(prior.artifact.retrievedAt))latest.set(id,{file,artifact,rows:holdings});
 }
 const ids=[...latest.keys()];
 const states=ids.length?await db.$queryRawUnsafe<any[]>(`SELECT e.id,EXISTS(SELECT 1 FROM etf_holding_snapshots s WHERE s.etf_id=e.id AND s.canonical_row_count>0) has_snapshot,EXISTS(SELECT 1 FROM etf_holding_snapshots s WHERE s.etf_id=e.id AND s.effective_date IS NOT NULL AND s.canonical_row_count>0) has_dated,EXISTS(SELECT 1 FROM holdings h WHERE h.etf_id=e.id) has_legacy FROM etfs e WHERE e.id=ANY($1::text[])`,ids):[];
 const state=new Map(states.map(x=>[x.id,x]));
 const skippedDueBetterSource=states.filter(x=>x.has_dated||x.has_legacy).length;
 const selected=[...latest.entries()].filter(([id])=>{const s=state.get(id);return s&&!s.has_snapshot&&!s.has_legacy}).slice(0,limit);
 let written=0,failed=0;
 for(const [etfId,item] of selected){try{
  const retrievedAt=new Date(item.artifact.retrievedAt),payloadHash=item.artifact.contentHash??createHash("sha256").update(JSON.stringify(item.artifact.payload)).digest("hex"),sourceRecordId=`YAHOO:${payloadHash}`,snapshotId=randomUUID(),sourceUrl=item.artifact.sourceUrl??"https://finance.yahoo.com/";
  const rows=item.rows.flatMap((r:any,i:number)=>{const name=String(r.holdingName??r.name??"").trim();if(!name)return[];return[{rank:i+1,name,ticker:r.symbol??null,weight:pct(r.holdingPercent??r.weight),raw:r}]});if(!rows.length)throw new Error("PARSE_EMPTY");
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe(`INSERT INTO etf_holding_snapshots(id,etf_id,effective_date,report_date,source,source_type,source_url,source_record_id,retrieved_at,checksum,source_row_count,parsed_row_count,canonical_row_count,verification_status,license_status,completeness_status,quality_status,quality_metrics,parser_version,archive_lineage) VALUES($1::uuid,$2,NULL,NULL,'YAHOO_QUOTE_SUMMARY','ARCHIVED_PROVIDER_OBSERVATION',$3,$4,$5,$6,$7,$7,$7,'SOURCE_PARSED','TERMS_REVIEW_REQUIRED','TOP_HOLDINGS_ONLY','PARTIAL_DATE_UNKNOWN',$8::jsonb,'yahoo-top-holdings-v2',$9::jsonb) ON CONFLICT(etf_id,source,source_record_id) WHERE effective_date IS NULL AND source_record_id IS NOT NULL DO NOTHING`,snapshotId,etfId,sourceUrl,sourceRecordId,retrievedAt,payloadHash,rows.length,JSON.stringify({sourceDateStatus:"UNKNOWN",retrievedAt:retrievedAt.toISOString()}),JSON.stringify({provider:"YAHOO_QUOTE_SUMMARY",archive:item.file,sourceDateStatus:"UNKNOWN"}));
   const found=await tx.$queryRawUnsafe<Array<{id:string}>>(`SELECT id::text FROM etf_holding_snapshots WHERE etf_id=$1 AND source='YAHOO_QUOTE_SUMMARY' AND source_record_id=$2 AND effective_date IS NULL`,etfId,sourceRecordId);const id=found[0]?.id??snapshotId;
   for(const r of rows)await tx.$executeRawUnsafe(`INSERT INTO etf_holdings(id,snapshot_id,etf_id,effective_date,holding_type,holding_name,ticker,weight,source_row_id,verification_status,quality_status,raw_row) VALUES($1::uuid,$2::uuid,$3,NULL,'SECURITY',$4,$5,$6,$7,'SOURCE_PARSED','PARTIAL_DATE_UNKNOWN',$8::jsonb) ON CONFLICT(snapshot_id,source_row_id) DO NOTHING`,randomUUID(),id,etfId,r.name,r.ticker,r.weight,`${r.rank}:${r.ticker??r.name}`.slice(0,240),JSON.stringify(r.raw));
  });written++;
 }catch{failed++}}
 console.log(JSON.stringify({target:limit,attempted:selected.length,written,failed,skippedDueBetterSource,archiveCandidates:latest.size}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
