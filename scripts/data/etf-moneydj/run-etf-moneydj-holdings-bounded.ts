import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { load } from "cheerio";

const engine=path.resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if(process.platform==="win32"&&!process.env.PRISMA_QUERY_ENGINE_LIBRARY)process.env.PRISMA_QUERY_ENGINE_LIBRARY=engine;
const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}});
const codes=(process.argv.find(x=>x.startsWith("--codes="))?.slice(8)??"").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
const limit=Number(process.argv.find(x=>x.startsWith("--limit="))?.slice(8)??"10");
const offset=Number(process.argv.find(x=>x.startsWith("--offset="))?.slice(9)??"0");
const dryRun=process.argv.includes("--dry-run");
const clean=(s:string)=>s.replace(/\s+/g," ").trim();
const num=(s:string)=>{const n=Number(s.replace(/[,%\s]/g,""));return Number.isFinite(n)?n:null};

function parse(html:string){
 const $=load(html);let table:any=null;
 $("table").each((_,t)=>{const h=clean($(t).find("tr").first().text());if(/個股名稱/.test(h)&&/投資比例/.test(h))table=t});
 if(!table)return null;
 const context=clean($(table).prevAll().slice(0,8).text()+" "+$(table).parent().prevAll().slice(0,5).text());
 const matches=[...context.matchAll(/資料日期[：:]\s*(20\d{2})\/(\d{2})\/(\d{2})/g)];
 const m=matches.at(-1);if(!m)return null;const asOfDate=`${m[1]}-${m[2]}-${m[3]}`;
 const rows:any[]=[];$(table).find("tr").slice(1).each((_,tr)=>{const c=$(tr).find("th,td").map((__,x)=>clean($(x).text())).get();if(c.length<2)return;const weight=num(c[1]);if(weight==null)return;const sm=c[0].match(/\(([^()]+)\)\s*$/);rows.push({name:clean(c[0].replace(/\([^()]+\)\s*$/, "")),ticker:sm?.[1]??null,weight,quantity:num(c[2]??"")})});
 return rows.length?{asOfDate,rows}:null;
}

async function main(){
 const etfs=codes.length?await db.$queryRawUnsafe<any[]>(`SELECT id,code,exchange,data_source FROM etfs WHERE upper(code)=ANY($1::text[]) ORDER BY code`,codes):await db.$queryRawUnsafe<any[]>(`SELECT id,code,exchange,data_source FROM etfs WHERE is_active=true ORDER BY id OFFSET $1 LIMIT $2`,offset,limit);
 const results:any[]=[];
 for(const e of etfs){
  try{
   const moneydjId=e.exchange==="TWSE"?`${e.code}.TW`:e.exchange==="TPEx"?`${e.code}.TWO`:/^[A-Za-z0-9.^=-]+$/.test(e.data_source??"")?e.data_source:e.code;
   const sourceUrl=`https://www.moneydj.com/ETF/X/Basic/Basic0007.xdjhtm?etfid=${encodeURIComponent(moneydjId)}`;
   const response=await fetch(sourceUrl,{headers:{"user-agent":"Mozilla/5.0 SmartFund Holdings MVP/1.0"},signal:AbortSignal.timeout(30000)});
   if(!response.ok)throw new Error(`HTTP_${response.status}`);
   const html=await response.text(),parsed=parse(html);
   if(!parsed)throw new Error("HOLDINGS_UNAVAILABLE");
   const checksum=createHash("sha256").update(html).digest("hex"),effectiveDate=new Date(`${parsed.asOfDate}T00:00:00Z`);
   if(!dryRun)await db.$transaction(async tx=>{
    const snapshot=await tx.etfHoldingSnapshot.upsert({
     where:{etfId_effectiveDate_sourceUrl_checksum:{etfId:e.id,effectiveDate,sourceUrl,checksum}},
     create:{id:randomUUID(),etfId:e.id,effectiveDate,source:"MONEYDJ_ETF_PUBLIC",sourceType:"PUBLIC_DATA_PROVIDER",sourceUrl,retrievedAt:new Date(),checksum,sourceRowCount:parsed.rows.length,parsedRowCount:parsed.rows.length,canonicalRowCount:parsed.rows.length,verificationStatus:"SOURCE_PARSED",licenseStatus:"PUBLIC_TERMS_REVIEW_REQUIRED",completenessStatus:"TOP_HOLDINGS_ONLY",qualityStatus:"PASS",parserVersion:"moneydj-basic0007-v1",archiveLineage:{provider:"MoneyDJ",moneydjId}},
     update:{retrievedAt:new Date(),canonicalRowCount:parsed.rows.length}
    });
    for(const [i,row] of parsed.rows.entries()){
     const sourceRowId=`${i+1}:${row.ticker??row.name}`;
     await tx.etfHoldingRow.upsert({where:{snapshotId_sourceRowId:{snapshotId:snapshot.id,sourceRowId}},create:{id:randomUUID(),snapshotId:snapshot.id,etfId:e.id,effectiveDate,holdingType:"SECURITY",holdingName:row.name,ticker:row.ticker,quantity:row.quantity,weight:row.weight,sourceRowId,verificationStatus:"SOURCE_PARSED",qualityStatus:"PASS",rawRow:row},update:{holdingName:row.name,ticker:row.ticker,quantity:row.quantity,weight:row.weight,rawRow:row}});
    }
   },{maxWait:10000,timeout:60000});
   results.push({code:e.code,status:parsed.rows.length<=10?"PARTIAL":"SUCCESS",holdings:parsed.rows.length,asOfDate:parsed.asOfDate,moneydjId});
  }catch(error){results.push({code:e.code,status:"HOLDINGS_UNAVAILABLE",error:String(error)})}
 }
 const success=results.filter(x=>x.status==="SUCCESS").length,partial=results.filter(x=>x.status==="PARTIAL").length,failed=results.length-success-partial;
 console.log(JSON.stringify({target:limit,offset,attempted:etfs.length,success,partial,failed,successRate:results.length?Number(((success+partial)/results.length*100).toFixed(2)):0,results},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
