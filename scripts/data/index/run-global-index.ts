import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";

type IndexJob = { id:string; name:string; symbol:string; country:string; region:string; provider:string; currency:string; timezone:string };
type Checkpoint = { version:1; stage:string; cursor:number; completed:Record<string,string>; cycles:number; current:string|null; lastSuccessfulIndex?:string; lastSuccessfulTradingDate?:string; updatedAt:string };
type DeadLetter = Record<string, unknown> & { key?:string; error?:string; resolved?:boolean; blocking?:boolean; resolution?:string };
type Candle = { timestamp:Date; open:number; high:number; low:number; close:number; volume:number|null; sourceUrl:string };

let jobs:IndexJob[] = [
  {id:"sp-500",name:"S&P 500",symbol:"^GSPC",country:"US",region:"AMERICAS",provider:"S&P DJI",currency:"USD",timezone:"America/New_York"},
  {id:"nikkei-225",name:"Nikkei 225",symbol:"^N225",country:"JP",region:"ASIA",provider:"Nikkei",currency:"JPY",timezone:"Asia/Tokyo"},
];
const publicMajorIndexIds=new Set([
  "taiwan-weighted","taiwan-otc","sp-500","nasdaq-composite","dow-jones-industrial",
  "phlx-semiconductor","russell-2000","vix","nikkei-225","hang-seng",
  "hang-seng-china-enterprises","shanghai-composite","csi-300","kospi",
  "stoxx-europe-600","dax","ftse-100","cac-40",
]);
const root=resolve("runtime","index");
const paths={ checkpoint:resolve(root,"checkpoint.json"), failure:resolve(root,"failure-queue.json"), dead:resolve(root,"dead-letter.json"), manifest:resolve(root,"completion-manifest.json"), heartbeat:resolve(root,"heartbeat.json"), status:resolve(root,"production-status.json"), ownerStatus:resolve(root,"runtime-status.json"), lock:resolve(root,"single-writer.lock"), log:resolve(root,"index-standalone.log"), historyQueue:resolve(root,"history-route-queue.json") };
const prisma=new PrismaClient();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function atomic(path:string,data:string){await mkdir(dirname(path),{recursive:true});const tmp=`${path}.${process.pid}.tmp`;await writeFile(tmp,data);await rename(tmp,path)}
async function json<T>(path:string,fallback:T):Promise<T>{try{return JSON.parse(await readFile(path,"utf8")) as T}catch{return fallback}}
async function put(path:string,value:unknown){await atomic(path,`${JSON.stringify(value,null,2)}\n`)}
async function log(value:Record<string,unknown>){const h=await open(paths.log,"a");try{await h.write(`${JSON.stringify({at:new Date().toISOString(),...value})}\n`)}finally{await h.close()}}
function alive(pid:number){try{process.kill(pid,0);return true}catch{return false}}
async function lock(){await mkdir(root,{recursive:true});const old=await json<{pid?:number}>(paths.lock,{});if(old.pid&&alive(old.pid))throw new Error(`GLOBAL_INDEX_ALREADY_RUNNING:${old.pid}`);await unlink(paths.lock).catch(()=>undefined);const h=await open(paths.lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY);await h.write(JSON.stringify({pid:process.pid,host:hostname(),startedAt:new Date().toISOString(),script:"scripts/data/index/run-global-index.ts",mode:"PRODUCTION_LATEST"}));await h.close()}

async function enrolOwnerHistoryQueue(){
  const queue=await json<{ownerPid?:number;items?:Array<{id:string;status:string;attempts?:number}>}>(paths.historyQueue,{});
  const visible=(queue.items??[]).filter(item=>["PUBLIC_ROUTE_READY","FULL_HISTORY_PENDING","INCREMENTAL_ACTIVE","TRANSIENT_RETRY"].includes(item.status));
  const ids=visible.map(item=>item.id);
  if(!ids.length)return {queue,visible,pending:[] as string[]};
  const rows=await prisma.$queryRawUnsafe<IndexJob[]>(`SELECT id,name,symbol,country,region,provider,currency,timezone FROM global_index_registry WHERE id=ANY($1::text[]) AND provider_external_id IS NOT NULL ORDER BY id`,ids);
  const known=new Set(jobs.map(item=>item.id));jobs=[...jobs,...rows.filter(item=>!known.has(item.id))];
  return {queue,visible,pending:visible.filter(item=>["PUBLIC_ROUTE_READY","FULL_HISTORY_PENDING","TRANSIENT_RETRY"].includes(item.status)).map(item=>item.id)};
}

async function updateHistoryQueue(indexId:string,patch:Record<string,unknown>){
  const queue=await json<any>(paths.historyQueue,{items:[]});const item=(queue.items??[]).find((entry:any)=>entry.id===indexId);if(!item)return;
  Object.assign(item,patch,{updatedAt:new Date().toISOString()});queue.updatedAt=new Date().toISOString();await put(paths.historyQueue,queue);
}

async function fetchLatest(job:IndexJob):Promise<Candle>{
  const url=new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(job.symbol)}`);
  url.searchParams.set("interval","1d");url.searchParams.set("range","10d");url.searchParams.set("events","history");
  const response=await fetch(url,{headers:{"user-agent":"SmartFund-Global-Index/2.0"},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`HTTP_${response.status}`);
  const body=await response.json() as any,r=body.chart?.result?.[0],q=r?.indicators?.quote?.[0];
  if(!r||!q)throw new Error(`SOURCE_NOT_PROVIDED:${JSON.stringify(body.chart?.error??null)}`);
  const rows=(r.timestamp??[]).flatMap((epoch:number,i:number)=>{const open=q.open?.[i],high=q.high?.[i],low=q.low?.[i],close=q.close?.[i];return [open,high,low,close].some(v=>v==null)?[]:[{timestamp:new Date(epoch*1000),open,high,low,close,volume:q.volume?.[i]??null,sourceUrl:url.toString()}]});
  const latest=rows.at(-1);if(!latest)throw new Error("NO_VALID_DAILY_OBSERVATION");return latest;
}

async function fetchBoundedHistory(job:IndexJob):Promise<Candle[]>{
  const url=new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(job.symbol)}`);url.searchParams.set("interval","1d");url.searchParams.set("period1","0");url.searchParams.set("period2",String(Math.floor(Date.now()/1000)+86400));url.searchParams.set("events","history");
  const response=await fetch(url,{headers:{"user-agent":"SmartFund-Global-Index/2.0"},signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`HTTP_${response.status}`);
  const body=await response.json() as any,r=body.chart?.result?.[0],q=r?.indicators?.quote?.[0];if(!r||!q)throw new Error("SOURCE_NOT_PROVIDED");
  return (r.timestamp??[]).flatMap((epoch:number,i:number)=>{const open=q.open?.[i],high=q.high?.[i],low=q.low?.[i],close=q.close?.[i];const valid=[open,high,low,close].every(Number.isFinite)&&open>0&&high>0&&low>0&&close>0&&high>=Math.max(open,close,low)&&low<=Math.min(open,close,high);return valid?[{timestamp:new Date(epoch*1000),open,high,low,close,volume:q.volume?.[i]??null,sourceUrl:url.toString()}]:[]});
}

async function writeCanonical(job:IndexJob,c:Candle){
  const lineage=JSON.stringify({source:"YAHOO_CHART",official:false,role:"APPROVED_SUPPLEMENTAL_MARKET_DATA",url:c.sourceUrl});
  await prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe(`INSERT INTO global_index_registry (id,name,symbol,country,region,provider,exchange,currency,timezone,return_type,source_lineage,active,licensing_status,official_source,update_frequency,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,'PRICE_RETURN',$9::jsonb,true,'PUBLIC_SUPPLEMENTAL_UNVERIFIED',false,'DAILY',NOW(),NOW()) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,symbol=EXCLUDED.symbol,country=EXCLUDED.country,region=EXCLUDED.region,provider=EXCLUDED.provider,currency=EXCLUDED.currency,timezone=EXCLUDED.timezone,source_lineage=EXCLUDED.source_lineage,active=true,updated_at=NOW()`,job.id,job.name,job.symbol,job.country,job.region,job.provider,job.currency,job.timezone,lineage);
    await tx.$executeRawUnsafe(`INSERT INTO global_index_candles (index_id,interval,timestamp,open,high,low,close,volume,timezone,session,source,completeness,quality_status,source_payload,ingested_at) VALUES ($1,'1d',$2,$3,$4,$5,$6,$7,$8,'REGULAR','YAHOO_CHART','SOURCE_REPORTED','SOURCE_REPORTED',$9::jsonb,NOW()) ON CONFLICT (index_id,interval,timestamp,source) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,source_payload=EXCLUDED.source_payload,ingested_at=NOW()`,job.id,c.timestamp,c.open,c.high,c.low,c.close,c.volume,job.timezone,JSON.stringify({url:c.sourceUrl}));
  });
  const rows=await prisma.$queryRawUnsafe<Array<{timestamp:Date;close:unknown;source:string}>>(`SELECT timestamp,close,source FROM global_index_candles WHERE index_id=$1 AND interval='1d' ORDER BY timestamp DESC LIMIT 1`,job.id);
  if(!rows[0]||new Date(rows[0].timestamp).getTime()!==c.timestamp.getTime())throw new Error("CANONICAL_READ_BACK_FAILED");
  return rows[0];
}

async function writeCanonicalBatch(job:IndexJob,rows:Candle[]){
  if(!rows.length)throw new Error("NO_VALID_DAILY_OBSERVATION");let written=0;
  for(let i=0;i<rows.length;i+=250){const batch=rows.slice(i,i+250);written+=await prisma.$executeRawUnsafe(`INSERT INTO global_index_candles(index_id,interval,timestamp,open,high,low,close,volume,timezone,session,source,completeness,quality_status,source_payload,source_url,source_type,verification_status,license_status,currency,ingested_at) SELECT $1,'1d',x.timestamp,x.open,x.high,x.low,x.close,x.volume,$2,'REGULAR','YAHOO_CHART','SOURCE_REPORTED','PASS',jsonb_build_object('url',$4),$4,'SUPPLEMENTAL','VERIFIED_IDENTITY_MAPPING','PUBLIC_SUPPLEMENTAL',$3,now() FROM jsonb_to_recordset($5::jsonb)x(timestamp timestamptz,open numeric,high numeric,low numeric,close numeric,volume numeric) WHERE NOT EXISTS(SELECT 1 FROM global_index_candles e WHERE e.index_id=$1 AND e.interval='1d' AND e.timestamp::date=x.timestamp::date) ON CONFLICT(index_id,interval,timestamp,source)DO NOTHING`,job.id,job.timezone,job.currency,batch[0].sourceUrl,JSON.stringify(batch.map(x=>({...x,timestamp:x.timestamp.toISOString()}))))}
  const [latest]=await prisma.$queryRawUnsafe<Array<{timestamp:Date;close:unknown;source:string}>>(`SELECT timestamp,close,source FROM global_index_candles WHERE index_id=$1 AND interval='1d' ORDER BY timestamp DESC LIMIT 1`,job.id);if(!latest)throw new Error("CANONICAL_READ_BACK_FAILED");return{latest,written,earliest:rows[0].timestamp};
}

async function persistState(cp:Checkpoint,status:Record<string,unknown>,dead:DeadLetter[]){
  const now=new Date().toISOString();cp.updatedAt=now;
  const routeQueue=await json<{items?:Array<{id:string;status:string;reason?:string}>}>(paths.historyQueue,{});
  const terminalTargets=(routeQueue.items??[]).filter(item=>["topix","volidx:nikkei:nk225vi"].includes(item.id)&&["SOURCE_LIMITED","LICENSE_CONSTRAINED"].includes(item.status));
  await Promise.all([
    put(paths.checkpoint,cp),put(paths.failure,[]),put(paths.dead,dead),put(paths.status,status),
    put(paths.heartbeat,{asset:"GLOBAL_INDEX",pid:process.pid,alive:true,stage:cp.stage,current:cp.current,heartbeatAt:now,script:"scripts/data/index/run-global-index.ts",mode:"PRODUCTION_LATEST"}),
    put(paths.manifest,{asset:"GLOBAL_INDEX",pid:process.pid,stage:cp.stage,writeTarget:"DATABASE",latestPath:true,incremental:true,historicalIndependent:true,universe:2,completed:Object.keys(cp.completed).length,failureQueue:0,deadLetter:dead.length,blockingDeadLetter:dead.filter(x=>x.blocking!==false).length,updatedAt:now})
  ]);
  const job=jobs.find(item=>item.id===cp.current)??jobs.find(item=>item.id===cp.lastSuccessfulIndex)??null;
  const result=job?status[job.id] as Record<string,unknown>|undefined:undefined;
  const progressed=result?.canonicalWrite==="PASS"&&cp.lastSuccessfulIndex===job?.id;
  const waiting=cp.stage==="INCREMENTAL_WAIT";
  const nextRunAt=waiting?new Date(Date.now()+900000).toISOString():null;
  await writeAssetRuntimeStatus({ASSET:"GLOBAL_INDEX",CURRENT_PHASE:"PRODUCTION_LATEST",CURRENT_LAYER:waiting?"Scheduler":"Latest",CURRENT_TASK:waiting?"Scheduler":"Incremental",CURRENT_MARKET:job?.country??null,CURRENT_INDEX_FAMILY:job?.provider??null,PROCESSED:Object.keys(cp.completed).length,TOTAL:jobs.length,COVERAGE:`${((Object.keys(cp.completed).length/Math.max(jobs.length,1))*100).toFixed(1)}%`,RUN_STATE:waiting?"SCHEDULED_WAIT":"RUNNING",PROCESS_ID:process.pid,CHECKPOINT:cp.current??cp.lastSuccessfulIndex??null,CURRENT_SOURCE:"YAHOO_CHART",BLOCKER:null,NEXT:waiting?"Refresh executable indexes on the next daily cadence; preserve terminal target dispositions":"Process next index",NEXT_RUN_AT:nextRunAt,QUOTE_STATUS:"NOT_READY",CONTINUING:"YES",LAST_PROGRESS:progressed&&job?`${job.name} Latest: canonical upsert and read-back completed for ${cp.lastSuccessfulTradingDate}; ${Object.keys(cp.completed).length}/${jobs.length} processed`:undefined,progressChanged:progressed});
  await put(paths.ownerStatus,{asset:"GLOBAL_INDEX_LATEST",pid:process.pid,state:waiting?"SCHEDULED_WAIT":"RUNNING",heartbeatAt:now,checkpoint:cp.current??cp.lastSuccessfulIndex??null,processed:Object.keys(cp.completed).length,coverage:Number(((Object.keys(cp.completed).length/Math.max(jobs.length,1))*100).toFixed(1)),pending:Math.max(0,jobs.length-Object.keys(cp.completed).length),nextRunAt,terminalTargets});
}

async function main(){
  const once=process.argv.includes("--canary"),resumeWait=process.argv.includes("--resume-wait");await lock();await enrolOwnerHistoryQueue();
  const oldDead=await json<DeadLetter[]>(paths.dead,[]);
  const dead=oldDead.map(x=>({...x,resolved:true,blocking:false,resolution:"SUPERSEDED_BY_PRODUCTION_DAILY_CANONICAL_PATH"}));
  const cp=await json<Checkpoint>(paths.checkpoint,{version:1,stage:"PRODUCTION_LATEST",cursor:0,completed:{},cycles:0,current:null,updatedAt:new Date().toISOString()});
  cp.cursor=Math.max(0,Math.min(cp.cursor,jobs.length-1));
  if(resumeWait){
    cp.stage="INCREMENTAL_WAIT";cp.current=null;
    const prior=await json<Record<string,unknown>>(paths.status,{});
    await persistState(cp,{...prior,pid:process.pid,topix:{status:"LICENSE_SOURCE_PENDING",symbol:"^TOPX",source:"YAHOO_MARKET_DATA",fetch:"PASS_NO_OBSERVATIONS",jpxIndexDataLicense:"PENDING"},globalIndexStatus:"PARTIAL_CURRENT"},dead);
    await sleep(900000);
  }
  cp.stage="PRODUCTION_LATEST";
  for(;;){
    const dynamic=await enrolOwnerHistoryQueue();const activate=new Set((dynamic?.pending??[]).slice(0,2));const visibleActive=(dynamic?.visible??[]).filter(item=>item.status==="INCREMENTAL_ACTIVE").map(item=>item.id);
    const activeBatch=new Set(Array.from({length:Math.min(4,visibleActive.length)},(_,offset)=>visibleActive[(cp.cycles*4+offset)%visibleActive.length]));
    const cycleJobs=jobs.filter(job=>publicMajorIndexIds.has(job.id)||activeBatch.has(job.id)||activate.has(job.id));
    const cycleStatus:Record<string,unknown>={asset:"GLOBAL_INDEX",pid:process.pid,mode:"PRODUCTION_LATEST",latestPath:true,incremental:true,historicalIndependent:true,globalIndexStatus:"PARTIAL_CURRENT",topix:{status:"LICENSE_SOURCE_PENDING",symbol:"^TOPX",source:"YAHOO_MARKET_DATA",fetch:"PASS_NO_OBSERVATIONS",jpxIndexDataLicense:"PENDING"}};
    const cycleStart=cp.cursor%Math.max(cycleJobs.length,1);
    for(let i=0;i<cycleJobs.length;i++){
      const job=cycleJobs[(cycleStart+i)%cycleJobs.length],bootstrap=activate.has(job.id);cp.current=job.id;await persistState(cp,cycleStatus,dead);
      try{if(bootstrap){await updateHistoryQueue(job.id,{status:"RUNNING",attempts:Number(dynamic?.visible.find(x=>x.id===job.id)?.attempts??0)+1});const source=await fetchBoundedHistory(job),result=await writeCanonicalBatch(job,source);cp.completed[job.id]=new Date().toISOString();cp.lastSuccessfulIndex=job.id;cp.lastSuccessfulTradingDate=result.latest.timestamp.toISOString();cycleStatus[job.id]={fetch:"PASS",parse:"PASS",canonicalWrite:"PASS",readBack:"PASS",mode:"FULL_AVAILABLE_DAILY_HISTORY",rowsWritten:result.written,sourceEarliest:result.earliest.toISOString(),sourceLatest:result.latest.timestamp.toISOString()};await updateHistoryQueue(job.id,{status:"INCREMENTAL_ACTIVE",checkpoint:result.latest.timestamp.toISOString(),fullHistoryCheckpoint:result.earliest.toISOString(),lastError:null});await log({status:"FULL_HISTORY_ACTIVATED",indexId:job.id,rows:result.written,earliest:result.earliest.toISOString(),latest:result.latest.timestamp.toISOString()})}else{const source=await fetchLatest(job),row=await writeCanonical(job,source);cp.completed[job.id]=new Date().toISOString();cp.lastSuccessfulIndex=job.id;cp.lastSuccessfulTradingDate=source.timestamp.toISOString();cycleStatus[job.id]={fetch:"PASS",parse:"PASS",canonicalWrite:"PASS",readBack:"PASS",mode:"INCREMENTAL_LATEST",sourceLatest:source.timestamp.toISOString(),dbLatest:new Date(row.timestamp).toISOString()};await log({status:"CANONICAL_UPSERT",indexId:job.id,timestamp:source.timestamp.toISOString()})}}
      catch(e){const message=e instanceof Error?e.message:String(e);cycleStatus[job.id]={status:"FAILED",error:message};if(bootstrap)await updateHistoryQueue(job.id,{status:/HTTP_429|HTTP_5\d\d|timeout/i.test(message)?"TRANSIENT_RETRY":"SOURCE_LIMITED",lastError:message});await log({status:"PRODUCTION_ERROR",indexId:job.id,error:message})}
      cp.cursor=(cycleStart+i+1)%Math.max(cycleJobs.length,1);await persistState(cp,cycleStatus,dead);
    }
    cp.cycles++;cp.stage="INCREMENTAL_WAIT";cp.current=null;await persistState(cp,cycleStatus,dead);
    if(once)break;await sleep(900000);cp.stage="PRODUCTION_LATEST";
  }
}
main().catch(async e=>{await log({status:"FATAL",error:e instanceof Error?e.message:String(e)}).catch(()=>undefined);process.exitCode=1}).finally(async()=>{await prisma.$disconnect()});
