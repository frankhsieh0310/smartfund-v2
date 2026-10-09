import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { getAuth, invalidateAuth } from "../../../lib/services/dataProviders/yahoo/yahooClient.ts";

const root=process.cwd(),dir=path.join(root,"runtime","etf-yahoo-product-modules"),cfg=JSON.parse(await fs.readFile(path.join(root,"config","etf-yahoo-product-modules.json"),"utf8"));
const engine=path.resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if(process.platform==="win32"&&!process.env.PRISMA_QUERY_ENGINE_LIBRARY)process.env.PRISMA_QUERY_ENGINE_LIBRARY=engine;
const prisma=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}}),once=process.argv.includes("--once"),continuous=process.argv.includes("--continuous");
const requestedCodes=(process.argv.find(x=>x.startsWith("--codes="))?.slice(8)??"").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
const wait=(n:number)=>new Promise(r=>setTimeout(r,n)),iso=()=>new Date().toISOString();
const num=(x:any)=>{const v=x&&typeof x==="object"?x.raw:x;return typeof v==="number"&&Number.isFinite(v)?v:null};
const text=(x:any)=>typeof x==="string"&&x.trim()?x.trim():null;
const day=(value:Date)=>new Date(`${value.toISOString().slice(0,10)}T00:00:00.000Z`);
const providerDate=(value:any)=>{const raw=value&&typeof value==="object"?value.raw:value;if(raw==null)return null;const parsed=typeof raw==="number"?new Date(raw*(raw<1e12?1000:1)):new Date(raw);return Number.isNaN(parsed.valueOf())?null:day(parsed)};
const percentPoints=(value:any)=>{const raw=num(value);if(raw==null)return null;const formatted=value&&typeof value==="object"&&typeof value.fmt==="string"?value.fmt:"";return formatted.includes("%")||Math.abs(raw)<=2?raw*100:raw};
const holdingWeight=(value:any)=>{const raw=num(value);if(raw!=null)return raw;const formatted=value&&typeof value==="object"?value.fmt:value;if(typeof formatted!=="string")return null;const parsed=Number(formatted.replace("%","").replaceAll(",","").trim());return Number.isFinite(parsed)?parsed/100:null};

type NormalizedHolding={rank:number;name:string;ticker:string|null;weight:number|null;sourceRowId:string;raw:any};
export function parseYahooTopHoldings(module:any):NormalizedHolding[]{
 const source=Array.isArray(module?.holdings)?module.holdings:[];
 return source.flatMap((row:any,index:number)=>{const name=text(row?.holdingName)??text(row?.name),ticker=text(row?.symbol);if(!name)return[];const rank=index+1;return[{rank,name,ticker,weight:percentPoints(row?.holdingPercent??row?.weight),sourceRowId:`${rank}:${ticker??name}`.slice(0,240),raw:row}]});
}

type NormalizedAllocation={name:string;weight:number};
export function parseYahooAllocationRows(value:any):NormalizedAllocation[]{
 const source=Array.isArray(value)?value:[];
 return source.flatMap((entry:any)=>Object.entries(entry??{}).flatMap(([name,raw])=>{const normalizedName=text(name),weight=holdingWeight(raw);return normalizedName&&weight!=null&&weight>=0&&weight<=1?[{name:normalizedName,weight}]:[]}));
}

async function writeSectorAllocations(etfId:string,module:any,sourceUrl:string,retrievedAt:Date):Promise<number>{
 const rows=parseYahooAllocationRows(module?.sectorWeightings);if(!rows.length)return 0;
 const observationDate=providerDate(module?.asOfDate??module?.date)??day(retrievedAt),source="YAHOO_QUOTE_SUMMARY";
 await prisma.$transaction(rows.map(row=>prisma.$executeRawUnsafe(`INSERT INTO etf_sector_allocations(id,etf_id,observation_date,sector_name,weight,source,source_url,retrieved_at,created_at,updated_at) VALUES($1::uuid,$2,$3::date,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT(etf_id,observation_date,source,sector_name) DO UPDATE SET weight=EXCLUDED.weight,source_url=EXCLUDED.source_url,retrieved_at=EXCLUDED.retrieved_at,updated_at=NOW()`,randomUUID(),etfId,observationDate,row.name,row.weight,source,sourceUrl,retrievedAt)));
 return rows.length;
}

async function writeCreditRatingAllocations(etfId:string,module:any,sourceUrl:string,retrievedAt:Date):Promise<number>{
 const rows=parseYahooAllocationRows(module?.bondRatings);if(!rows.length)return 0;
 const observationDate=providerDate(module?.asOfDate??module?.date)??day(retrievedAt),source="YAHOO_QUOTE_SUMMARY";
 await prisma.$transaction(rows.map(row=>prisma.$executeRawUnsafe(`INSERT INTO etf_credit_rating_allocations(id,etf_id,observation_date,credit_rating,weight,source,source_url,retrieved_at,created_at,updated_at) VALUES($1::uuid,$2,$3::date,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT(etf_id,observation_date,source,credit_rating) DO UPDATE SET weight=EXCLUDED.weight,source_url=EXCLUDED.source_url,retrieved_at=EXCLUDED.retrieved_at,updated_at=NOW()`,randomUUID(),etfId,observationDate,row.name,row.weight,source,sourceUrl,retrievedAt)));
 return rows.length;
}
type NormalizedPerformance={date:Date;return1m:number|null;return3m:number|null;return6m:number|null;returnYtd:number|null;return1y:number|null;return3y:number|null;return5y:number|null};
export function parseYahooFundPerformance(module:any,retrievedAt:Date):NormalizedPerformance|null{
 const trailing=module?.trailingReturns??module?.trailingReturnsNav??{};
 const result={date:providerDate(trailing?.asOfDate??module?.asOfDate??module?.performanceAsOfDate??module?.date)??day(retrievedAt),return1m:percentPoints(trailing?.oneMonth??trailing?.oneMonthReturn),return3m:percentPoints(trailing?.threeMonth??trailing?.threeMonthReturn),return6m:percentPoints(trailing?.sixMonth??trailing?.sixMonthReturn),returnYtd:percentPoints(trailing?.ytd??trailing?.yearToDateReturn),return1y:percentPoints(trailing?.oneYear??trailing?.oneYearReturn),return3y:percentPoints(trailing?.threeYear??trailing?.threeYearReturn),return5y:percentPoints(trailing?.fiveYear??trailing?.fiveYearReturn)};
 return Object.entries(result).some(([key,value])=>key!=="date"&&value!=null)?result:null;
}

async function writeTopHoldings(etfId:string,module:any,sourceUrl:string,retrievedAt:Date,payloadHash:string):Promise<number>{
 const rows=parseYahooTopHoldings(module);if(!rows.length)return 0;
 const effectiveDate=providerDate(module?.asOfDate??module?.date);
 if(!effectiveDate)return prisma.$transaction(async tx=>{
  const sourceRecordId=`YAHOO:${payloadHash}`,snapshotId=randomUUID();
  const found=await tx.$queryRawUnsafe<Array<{id:string}>>(`SELECT id::text FROM etf_holding_snapshots WHERE etf_id=$1 AND source='YAHOO_QUOTE_SUMMARY' AND source_record_id=$2 AND effective_date IS NULL LIMIT 1`,etfId,sourceRecordId);
  const id=found[0]?.id??snapshotId;
  if(!found.length)await tx.$executeRawUnsafe(`INSERT INTO etf_holding_snapshots(id,etf_id,effective_date,report_date,source,source_type,source_url,source_record_id,retrieved_at,checksum,source_row_count,parsed_row_count,canonical_row_count,verification_status,license_status,completeness_status,quality_status,quality_metrics,parser_version,archive_lineage) VALUES($1::uuid,$2,NULL,NULL,'YAHOO_QUOTE_SUMMARY','PROVIDER_OBSERVATION',$3,$4,$5,$6,$7,$7,$7,'SOURCE_PARSED','TERMS_REVIEW_REQUIRED','TOP_HOLDINGS_ONLY','PARTIAL_DATE_UNKNOWN',$8::jsonb,'yahoo-top-holdings-v2',$9::jsonb)`,id,etfId,sourceUrl,sourceRecordId,retrievedAt,payloadHash,rows.length,JSON.stringify({sourceDateStatus:"UNKNOWN",retrievedAt:retrievedAt.toISOString()}),JSON.stringify({provider:"YAHOO_QUOTE_SUMMARY",module:"topHoldings",payloadHash,sourceDateStatus:"UNKNOWN"}));
  for(const row of rows)await tx.$executeRawUnsafe(`INSERT INTO etf_holdings(id,snapshot_id,etf_id,effective_date,holding_type,holding_name,ticker,weight,source_row_id,verification_status,quality_status,raw_row) VALUES($1::uuid,$2::uuid,$3,NULL,'SECURITY',$4,$5,$6,$7,'SOURCE_PARSED','PARTIAL_DATE_UNKNOWN',$8::jsonb) ON CONFLICT(snapshot_id,source_row_id) DO UPDATE SET holding_name=EXCLUDED.holding_name,ticker=EXCLUDED.ticker,weight=EXCLUDED.weight,quality_status=EXCLUDED.quality_status,raw_row=EXCLUDED.raw_row`,randomUUID(),id,etfId,row.name,row.ticker,row.weight,row.sourceRowId,JSON.stringify(row.raw));
  return rows.length;
 });
 return prisma.$transaction(async(tx)=>{
  const snapshot=await tx.etfHoldingSnapshot.upsert({
   where:{etfId_effectiveDate_sourceUrl_checksum:{etfId,effectiveDate,sourceUrl,checksum:payloadHash}},
   create:{id:randomUUID(),etfId,effectiveDate,source:"YAHOO_QUOTE_SUMMARY",sourceType:"PROVIDER_OBSERVATION",sourceUrl,sourceRecordId:`YAHOO:${payloadHash}`,retrievedAt,checksum:payloadHash,sourceRowCount:rows.length,parsedRowCount:rows.length,canonicalRowCount:rows.length,verificationStatus:"SOURCE_PARSED",licenseStatus:"TERMS_REVIEW_REQUIRED",completenessStatus:"TOP_HOLDINGS_ONLY",qualityStatus:"PASS",parserVersion:"yahoo-top-holdings-v1",archiveLineage:{provider:"YAHOO_QUOTE_SUMMARY",module:"topHoldings",payloadHash}},
   update:{retrievedAt,sourceRowCount:rows.length,parsedRowCount:rows.length,canonicalRowCount:rows.length},
  });
  for(const row of rows)await tx.etfHoldingRow.upsert({where:{snapshotId_sourceRowId:{snapshotId:snapshot.id,sourceRowId:row.sourceRowId}},create:{id:randomUUID(),snapshotId:snapshot.id,etfId,effectiveDate,holdingType:"SECURITY",holdingName:row.name,ticker:row.ticker,weight:row.weight,sourceRowId:row.sourceRowId,verificationStatus:"SOURCE_PARSED",qualityStatus:"PASS",rawRow:row.raw},update:{holdingName:row.name,ticker:row.ticker,weight:row.weight,rawRow:row.raw}});
  return rows.length;
 });
}

async function writePerformance(etfId:string,module:any,retrievedAt:Date):Promise<number>{
 const p=parseYahooFundPerformance(module,retrievedAt);if(!p)return 0;
 await prisma.$transaction([
  prisma.$executeRawUnsafe(`INSERT INTO etf_performances(id,etf_id,date,return_1m,return_3m,return_6m,return_ytd,return_1y,return_3y,return_5y,created_at) VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,NOW()) ON CONFLICT(etf_id,date) DO UPDATE SET return_1m=COALESCE(EXCLUDED.return_1m,etf_performances.return_1m),return_3m=COALESCE(EXCLUDED.return_3m,etf_performances.return_3m),return_6m=COALESCE(EXCLUDED.return_6m,etf_performances.return_6m),return_ytd=COALESCE(EXCLUDED.return_ytd,etf_performances.return_ytd),return_1y=COALESCE(EXCLUDED.return_1y,etf_performances.return_1y),return_3y=COALESCE(EXCLUDED.return_3y,etf_performances.return_3y),return_5y=COALESCE(EXCLUDED.return_5y,etf_performances.return_5y)`,randomUUID(),etfId,p.date,p.return1m,p.return3m,p.return6m,p.returnYtd,p.return1y,p.return3y,p.return5y),
  prisma.$executeRawUnsafe(`UPDATE etfs SET return_1m=COALESCE($2,return_1m),return_3m=COALESCE($3,return_3m),return_6m=COALESCE($4,return_6m),return_ytd=COALESCE($5,return_ytd),return_1y=COALESCE($6,return_1y),return_3y=COALESCE($7,return_3y),return_5y=COALESCE($8,return_5y),updated_at=NOW() WHERE id=$1`,etfId,p.return1m,p.return3m,p.return6m,p.returnYtd,p.return1y,p.return3y,p.return5y),
 ]);
 return 1;
}
async function read(f:string,x:any){try{return JSON.parse(await fs.readFile(f,"utf8"))}catch{return x}}
async function atomic(f:string,x:any){await fs.mkdir(path.dirname(f),{recursive:true});const t=`${f}.${process.pid}.tmp`;await fs.writeFile(t,JSON.stringify(x,null,2)+"\n");await fs.rename(t,f)}
async function fetchModules(symbol:string){for(let attempt=0;attempt<3;attempt++){const auth=await getAuth();const u=`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${cfg.modules.join(",")}${auth?`&crumb=${encodeURIComponent(auth.crumb)}`:""}`;const r=await fetch(u,{headers:{"user-agent":"Mozilla/5.0 (SmartFund ETF Product Data)",...(auth?{cookie:auth.cookie}:{})},signal:AbortSignal.timeout(30000)});if(r.ok)return {url:u.replace(/&crumb=.*/,"&crumb=REDACTED"),payload:await r.json()};if(r.status===401){invalidateAuth();continue}if(r.status===429||r.status>=500){await wait((attempt+1)*5000);continue}throw new Error(`YAHOO_PRODUCT_HTTP_${r.status}`)}throw new Error("YAHOO_PRODUCT_RETRY_EXHAUSTED")}
async function main(){await fs.mkdir(path.join(dir,"raw"),{recursive:true});const lock=path.join(dir,"worker.lock");try{await fs.writeFile(lock,JSON.stringify({pid:process.pid,at:iso()}),{flag:"wx"})}catch{throw new Error("ETF_YAHOO_PRODUCT_ALREADY_RUNNING")}
 try{let cp=await read(path.join(dir,"checkpoint.json"),{cursor:null,batches:0,processed:0,anyProductData:0,canonicalRows:0,rawPayloads:0,retryWait:0,retryExhausted:0,moduleUnavailable:{}});
  do{const rows=requestedCodes.length?await prisma.$queryRawUnsafe<any[]>(`SELECT id,code,CASE WHEN data_source ~ '^[A-Za-z0-9.^=-]+$' THEN data_source WHEN exchange='TWSE' THEN code||'.TW' WHEN exchange='TPEx' THEN code||'.TWO' ELSE code END data_source FROM etfs WHERE upper(code)=ANY($1::text[]) ORDER BY code`,requestedCodes):await prisma.$queryRawUnsafe<any[]>(`SELECT id,code,CASE WHEN data_source ~ '^[A-Za-z0-9.^=-]+$' THEN data_source WHEN exchange='TWSE' THEN code||'.TW' WHEN exchange='TPEx' THEN code||'.TWO' ELSE code END data_source FROM etfs WHERE ($1::text IS NULL OR id>$1) ORDER BY id LIMIT $2`,cp.cursor,cfg.batchSize);if(!rows.length){cp={...cp,cursor:null,state:"COMPLETE_AS_AVAILABLE",nextRunAt:new Date(Date.now()+86400000).toISOString(),updatedAt:iso()};await atomic(path.join(dir,"checkpoint.json"),cp);if(!continuous)break;await wait(86400000);continue}
   for(const e of rows){const modules:any={};try{const {url,payload}=await fetchModules(e.data_source),result=payload?.quoteSummary?.result?.[0];if(!result)throw new Error(`YAHOO_PRODUCT_NO_RESULT:${payload?.quoteSummary?.error?.code??"EMPTY"}`);for(const m of cfg.modules){modules[m]=result[m]??null;if(!result[m])cp.moduleUnavailable[m]=(cp.moduleUnavailable[m]??0)+1}const hash=createHash("sha256").update(JSON.stringify(payload)).digest("hex"),retrievedAt=new Date();await atomic(path.join(dir,"raw",`${e.id}-${hash.slice(0,12)}.json`),{provider:"YAHOO_QUOTE_SUMMARY",symbol:e.data_source,modules:cfg.modules,retrievedAt:retrievedAt.toISOString(),contentHash:hash,sourceUrl:url,payload});cp.rawPayloads++;
    const f=result.fundProfile??{},k=result.defaultKeyStatistics??{},s=result.summaryDetail??{},p=result.price??{};const values={nameEn:text(p.longName)??text(p.shortName),category:text(f.categoryName),currency:text(p.currency),inception:num(k.fundInceptionDate),nav:num(s.navPrice),aum:num(s.totalAssets),expense:num(k.annualReportExpenseRatio),yield:num(s.yield),beta:num(k.beta3Year)};const changed=Object.values(values).filter(v=>v!==null&&v!==undefined).length;
    const counts={profile:Object.keys(f).length?1:0,nav:values.nav!=null?1:0,aum:values.aum!=null?1:0,fees:values.expense!=null?1:0,distributions:values.yield!=null?1:0,topHoldings:(result.topHoldings?.holdings??[]).length,allocations:(result.topHoldings?.sectorWeightings??[]).length,performance:Object.keys(result.fundPerformance??{}).length?1:0,risk:values.beta!=null?1:0,bond:Object.keys(result.topHoldings?.bondRatings??{}).length?1:0};for(const [key,n] of Object.entries(counts))cp[key]=(cp[key]??0)+Number(n);
    cp.anyProductData++;cp.standardizedPerformance=(cp.standardizedPerformance??0)+await writePerformance(e.id,result.fundPerformance,retrievedAt);cp.standardizedHoldings=(cp.standardizedHoldings??0)+await writeTopHoldings(e.id,result.topHoldings,url,retrievedAt,hash);cp.standardizedSectorAllocations=(cp.standardizedSectorAllocations??0)+await writeSectorAllocations(e.id,result.topHoldings,url,retrievedAt);cp.standardizedCreditRatingAllocations=(cp.standardizedCreditRatingAllocations??0)+await writeCreditRatingAllocations(e.id,result.topHoldings,url,retrievedAt);
    if(changed)await prisma.$executeRawUnsafe(`UPDATE etfs SET name_en=COALESCE($2,name_en),category=COALESCE($3,category),currency=COALESCE($4,currency),inception_date=COALESCE(to_timestamp($5)::date,inception_date),latest_nav=COALESCE($6,latest_nav),aum=COALESCE($7,aum),expense_ratio=COALESCE($8,expense_ratio),dividend_yield=COALESCE($9,dividend_yield),beta=COALESCE($10,beta),updated_at=NOW() WHERE id=$1`,e.id,values.nameEn,values.category,values.currency,values.inception,values.nav,values.aum,values.expense,values.yield,values.beta);cp.canonicalRows+=changed;
   }catch(error){const msg=error instanceof Error?error.message:String(error);if(/429|5\d\d|timeout|read-only/i.test(msg))cp.retryWait++;else cp.retryExhausted++;await fs.appendFile(path.join(dir,"failures.jsonl"),JSON.stringify({etfId:e.id,code:e.code,symbol:e.data_source,error:msg,state:/429|5\d\d|timeout|read-only/i.test(msg)?"RETRY_WAIT":"RETRY_EXHAUSTED",at:iso()})+"\n")}
    cp.processed++;if(!requestedCodes.length)cp.cursor=e.id;cp.processId=process.pid;cp.state="AUTO_CONTINUING";cp.updatedAt=iso();await atomic(path.join(dir,"checkpoint.json"),cp);await wait(cfg.requestPacingMs)}cp.batches++;await atomic(path.join(dir,"checkpoint.json"),cp);if(once||requestedCodes.length||!continuous)break
  }while(true)
 }finally{await prisma.$disconnect();await fs.unlink(lock).catch(()=>{})}}
async function validateRawFixture(file:string,write:boolean){
 const archived=JSON.parse(await fs.readFile(path.resolve(file),"utf8")),result=archived?.payload?.quoteSummary?.result?.[0];if(!result)throw new Error("VALIDATION_FIXTURE_NO_RESULT");
 const holdings=parseYahooTopHoldings(result.topHoldings),performance=parseYahooFundPerformance(result.fundPerformance,new Date(archived.retrievedAt));
 const sectorAllocations=parseYahooAllocationRows(result.topHoldings?.sectorWeightings),creditRatingAllocations=parseYahooAllocationRows(result.topHoldings?.bondRatings);
 if(!holdings.length||!performance)throw new Error("VALIDATION_PARSER_EMPTY");
 if(Math.abs((performance.return1y??0)-20)>0.0001&&result.fundPerformance?.trailingReturns?.oneYear?.raw===0.2)throw new Error("VALIDATION_PERCENT_UNIT");
 const output:any={holdingsParsed:holdings.length,holdingFields:Object.keys(holdings[0]!),performanceParsed:Object.entries(performance).filter(([k,v])=>k!=="date"&&v!=null).map(([k])=>k),performanceDate:performance.date.toISOString().slice(0,10),sectorAllocationsParsed:sectorAllocations.length,creditRatingAllocationsParsed:creditRatingAllocations.length,write};
 if(write&&process.argv.includes("--allocations-only")){
  const etfId=path.basename(file).match(/^([0-9a-f-]{36})-/i)?.[1];if(!etfId)throw new Error("VALIDATION_ETF_ID_MISSING");
  const sourceUrl=archived.sourceUrl??`https://finance.yahoo.com/quote/${encodeURIComponent(archived.symbol)}`,retrievedAt=new Date(archived.retrievedAt);
  await writeSectorAllocations(etfId,result.topHoldings,sourceUrl,retrievedAt);await writeCreditRatingAllocations(etfId,result.topHoldings,sourceUrl,retrievedAt);
  console.log(JSON.stringify(output));await prisma.$disconnect();return;
 } if(write&&process.argv.includes("--performance-only")){
  const etfId=path.basename(file).match(/^([0-9a-f-]{36})-/i)?.[1];if(!etfId)throw new Error("VALIDATION_ETF_ID_MISSING");
  const before=await prisma.etfPerformance.count({where:{etfId,date:performance!.date}});await writePerformance(etfId,result.fundPerformance,new Date(archived.retrievedAt));const afterFirst=await prisma.etfPerformance.count({where:{etfId,date:performance!.date}});await writePerformance(etfId,result.fundPerformance,new Date(archived.retrievedAt));const afterSecond=await prisma.etfPerformance.count({where:{etfId,date:performance!.date}});
  Object.assign(output,{performanceBefore:before,performanceAfterFirst:afterFirst,performanceAfterSecond:afterSecond,performanceIdempotent:afterFirst===afterSecond});console.log(JSON.stringify(output));await prisma.$disconnect();return;
 } if(write){
  const etfId=path.basename(file).match(/^([0-9a-f-]{36})-/i)?.[1];if(!etfId)throw new Error("VALIDATION_ETF_ID_MISSING");
  const hash=archived.contentHash??createHash("sha256").update(JSON.stringify(archived.payload)).digest("hex"),sourceUrl=archived.sourceUrl??`https://finance.yahoo.com/quote/${encodeURIComponent(archived.symbol)}`,effectiveDate=providerDate(result.topHoldings?.asOfDate??result.topHoldings?.date)??day(new Date(archived.retrievedAt));
  const beforeSnapshots=await prisma.etfHoldingSnapshot.count({where:{etfId,checksum:hash}});
  await writeTopHoldings(etfId,result.topHoldings,sourceUrl,new Date(archived.retrievedAt),hash);await writePerformance(etfId,result.fundPerformance,new Date(archived.retrievedAt));await writeSectorAllocations(etfId,result.topHoldings,sourceUrl,new Date(archived.retrievedAt));await writeCreditRatingAllocations(etfId,result.topHoldings,sourceUrl,new Date(archived.retrievedAt));
  const firstSnapshots=await prisma.etfHoldingSnapshot.count({where:{etfId,checksum:hash}}),firstRows=await prisma.etfHoldingRow.count({where:{etfId,effectiveDate,snapshot:{checksum:hash}}});
  await writeTopHoldings(etfId,result.topHoldings,sourceUrl,new Date(archived.retrievedAt),hash);await writePerformance(etfId,result.fundPerformance,new Date(archived.retrievedAt));await writeSectorAllocations(etfId,result.topHoldings,sourceUrl,new Date(archived.retrievedAt));await writeCreditRatingAllocations(etfId,result.topHoldings,sourceUrl,new Date(archived.retrievedAt));
  const secondSnapshots=await prisma.etfHoldingSnapshot.count({where:{etfId,checksum:hash}}),secondRows=await prisma.etfHoldingRow.count({where:{etfId,effectiveDate,snapshot:{checksum:hash}}}),performanceRows=await prisma.etfPerformance.count({where:{etfId,date:performance!.date}});
  Object.assign(output,{snapshotBefore:beforeSnapshots,snapshotAfterFirst:firstSnapshots,snapshotAfterSecond:secondSnapshots,holdingsAfterFirst:firstRows,holdingsAfterSecond:secondRows,performanceRows,holdingIdempotent:firstSnapshots===secondSnapshots&&firstRows===secondRows}); console.log(JSON.stringify(output));await prisma.$disconnect();
}
}
const validationIndex=process.argv.indexOf("--validate-raw");
if(validationIndex>=0){const file=process.argv[validationIndex+1];if(!file)throw new Error("VALIDATION_FILE_REQUIRED");validateRawFixture(file,process.argv.includes("--write")).catch(e=>{console.error(e);process.exitCode=1})}
else main().catch(e=>{console.error(e);process.exitCode=1});
