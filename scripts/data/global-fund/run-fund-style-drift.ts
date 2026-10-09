import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeAssetRuntimeStatus } from "../runtime-status/write-asset-runtime-status.ts";

type Holding = { date: Date; key: string; weight: unknown; sector: string | null; country: string | null; currency: string | null };
type Metric = { code: string; value: number; method: string };
const prisma = new PrismaClient();
const runtime = resolve("runtime/global-fund/style-drift");
const checkpointPath = resolve(runtime, "checkpoint.json");
const healthPath = resolve(runtime, "health.json");
const queuePath = resolve(runtime, "queue.json");
const canary = process.argv.includes("--canary");
const scheduler = process.env.FUND_STYLE_DRIFT_SCHEDULER === "1";
const limit = canary ? 1 : 5;
const iso = () => new Date().toISOString();
async function atomic(file: string, value: unknown) { await mkdir(dirname(file), { recursive: true }); const temporary=`${file}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`); await rename(temporary,file); }
async function priorCheckpoint(){return readFile(checkpointPath,"utf8").then(JSON.parse).catch(()=>({}));}
const grouped=(rows:Holding[],field:"sector"|"country"|"currency")=>{const out=new Map<string,number>();for(const row of rows){const key=row[field]??"UNKNOWN";out.set(key,(out.get(key)??0)+Number(row.weight));}return out;};
const l1=(left:Map<string,number>,right:Map<string,number>)=>[...new Set([...left.keys(),...right.keys()])].reduce((sum,key)=>sum+Math.abs((left.get(key)??0)-(right.get(key)??0)),0)/2;
function calculate(previous:Holding[],current:Holding[]):Metric[]{
  const p=new Map(previous.map(row=>[row.key,Number(row.weight)])),c=new Map(current.map(row=>[row.key,Number(row.weight)]));
  const keys=[...new Set([...p.keys(),...c.keys()])]; const turnover=keys.reduce((sum,key)=>sum+Math.abs((p.get(key)??0)-(c.get(key)??0)),0)/2;
  const hhi=(values:Iterable<number>)=>[...values].reduce((sum,value)=>sum+(value/100)**2,0);
  const dot=keys.reduce((sum,key)=>sum+(p.get(key)??0)*(c.get(key)??0),0),pn=Math.sqrt([...p.values()].reduce((s,v)=>s+v*v,0)),cn=Math.sqrt([...c.values()].reduce((s,v)=>s+v*v,0));
  return [
    {code:"STYLE_DRIFT_HOLDINGS_TURNOVER_PROXY",value:turnover,method:"PIT_WEIGHT_L1_HALF"},
    {code:"STYLE_DRIFT_CONCENTRATION_HHI_CHANGE",value:hhi(c.values())-hhi(p.values()),method:"PIT_HHI_CURRENT_MINUS_PREVIOUS"},
    {code:"STYLE_DRIFT_SECTOR_EXPOSURE",value:l1(grouped(previous,"sector"),grouped(current,"sector")),method:"PIT_SECTOR_WEIGHT_L1_HALF"},
    {code:"STYLE_DRIFT_COUNTRY_EXPOSURE",value:l1(grouped(previous,"country"),grouped(current,"country")),method:"PIT_COUNTRY_WEIGHT_L1_HALF"},
    {code:"STYLE_DRIFT_CURRENCY_EXPOSURE",value:l1(grouped(previous,"currency"),grouped(current,"currency")),method:"PIT_CURRENCY_WEIGHT_L1_HALF"},
    {code:"STYLE_PERSISTENCE_COSINE",value:pn&&cn?dot/(pn*cn):0,method:"PIT_HOLDING_WEIGHT_COSINE"},
  ].filter(metric=>Number.isFinite(metric.value));
}
async function main(){
  const cp=await priorCheckpoint(); const now=iso();
  const candidates=await prisma.$queryRawUnsafe<Array<{fundId:string;periods:number}>>(`SELECT fund_id AS "fundId",COUNT(DISTINCT as_of_date)::int periods FROM holdings WHERE asset_type='FUND' AND fund_id IS NOT NULL AND weight IS NOT NULL AND source IS NOT NULL GROUP BY fund_id HAVING COUNT(DISTINCT as_of_date)>=2 AND NOT EXISTS(SELECT 1 FROM fund_risk_metrics m WHERE m.fund_id=holdings.fund_id AND m.metric_code='STYLE_PERSISTENCE_COSINE' AND m.source='DERIVED_FROM_PIT_HOLDINGS' AND m.as_of_date=(SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.fund_id=holdings.fund_id)) ORDER BY fund_id LIMIT $1`,limit);
  if(!candidates.length){const state={status:"INPUT_CONSTRAINED",processedFunds:0,eligibleUniverse:0,lastSuccessfulRun:cp.lastSuccessfulRun??null,nextEligibleAt:new Date(Date.now()+86400000).toISOString(),lastError:"NO_FUND_WITH_TWO_VERIFIED_HOLDINGS_PERIODS",lifecycleHook:"EXISTING_GLOBAL_FUND_SUPERVISOR",autoContinueWhenEligible:true};await atomic(checkpointPath,state);await atomic(healthPath,{owner:"fund-style-drift",runnerPid:process.pid,scheduler,autoContinuing:true,singleWriter:true,lastHeartbeat:now,...state});await writeAssetRuntimeStatus("FUND",{CURRENT_LAYER:"P2",CURRENT_TASK:"Style Drift",LAST_PROGRESS_AT:now,LAST_PROGRESS:"Style Drift eligibility checked: 0 funds with two verified holdings periods; INPUT_CONSTRAINED",CHECKPOINT:"runtime/global-fund/style-drift/checkpoint.json",NEXT:"WAIT_FOR_NEXT_VERIFIED_PIT_HOLDINGS_PERIOD",NEXT_RUN_AT:state.nextEligibleAt,STYLE_DRIFT_STATUS:"INPUT_CONSTRAINED",CONTINUING:"YES"});console.log(JSON.stringify(state));return;}
  const completed=[]; for(const candidate of candidates){
    const dates=await prisma.$queryRawUnsafe<Array<{date:Date}>>(`SELECT DISTINCT as_of_date AS date FROM holdings WHERE asset_type='FUND' AND fund_id=$1 AND weight IS NOT NULL AND source IS NOT NULL ORDER BY as_of_date DESC LIMIT 2`,candidate.fundId);
    if(dates.length<2)continue; const currentDate=dates[0].date,previousDate=dates[1].date;
    const rows=await prisma.$queryRawUnsafe<Holding[]>(`SELECT as_of_date AS date,COALESCE(security_id::text,isin,cusip,ticker,holding_code,holding_name) AS key,weight::float8 weight,COALESCE(h.sector,s.sector) sector,COALESCE(h.country,s.country) country,COALESCE(h.currency,s.currency) currency FROM holdings h LEFT JOIN securities s ON s.id=h.security_id WHERE h.asset_type='FUND' AND h.fund_id=$1 AND h.as_of_date=ANY($2::date[]) AND h.weight IS NOT NULL AND h.source IS NOT NULL ORDER BY h.as_of_date,key`,candidate.fundId,[previousDate.toISOString().slice(0,10),currentDate.toISOString().slice(0,10)]);
    const previous=rows.filter(row=>new Date(row.date).getTime()===previousDate.getTime()),current=rows.filter(row=>new Date(row.date).getTime()===currentDate.getTime()),metrics=calculate(previous,current); if(!previous.length||!current.length||!metrics.length)continue;
    await prisma.$transaction(async tx=>{const lock=await tx.$queryRawUnsafe<Array<{locked:boolean}>>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:fund-style-drift:v1')) locked`);if(!lock[0]?.locked)throw new Error("FUND_STYLE_DRIFT_SINGLE_WRITER_LOCKED");for(const metric of metrics){const existing=await tx.$queryRawUnsafe<Array<{id:string}>>(`SELECT id FROM fund_risk_metrics WHERE fund_id=$1 AND share_class_id IS NULL AND metric_code=$2 AND as_of_date=$3::date AND source='DERIVED_FROM_PIT_HOLDINGS' AND calculation_method=$4 LIMIT 1`,candidate.fundId,metric.code,currentDate.toISOString().slice(0,10),metric.method);if(existing[0])continue;await tx.$executeRawUnsafe(`INSERT INTO fund_risk_metrics(id,fund_id,share_class_id,metric_code,period,value,as_of_date,currency,calculation_method,observation_count,source,return_semantics,start_date,end_date,created_at,updated_at) VALUES($1,$2,NULL,$3,'PIT_INTERVAL',$4,$5::date,NULL,$6,$7,'DERIVED_FROM_PIT_HOLDINGS',NULL,$8::date,$5::date,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,randomUUID(),candidate.fundId,metric.code,metric.value,currentDate.toISOString().slice(0,10),metric.method,previous.length+current.length,previousDate.toISOString().slice(0,10));}},{maxWait:10000,timeout:60000});
    const readback=await prisma.$queryRawUnsafe<Array<{count:number}>>(`SELECT COUNT(*)::int count FROM fund_risk_metrics WHERE fund_id=$1 AND as_of_date=$2::date AND source='DERIVED_FROM_PIT_HOLDINGS' AND metric_code LIKE 'STYLE_%'`,candidate.fundId,currentDate.toISOString().slice(0,10));if(Number(readback[0]?.count)<metrics.length)throw new Error("STYLE_DRIFT_READBACK_FAILED");completed.push({fundId:candidate.fundId,previousDate:previousDate.toISOString().slice(0,10),currentDate:currentDate.toISOString().slice(0,10),inputRows:previous.length+current.length,metrics:metrics.map(metric=>metric.code),observations:Number(readback[0].count)});
  }
  const finished=iso(),nextEligibleAt=new Date(Date.now()+86400000).toISOString(),status=completed.length?"CURRENT":"INPUT_CONSTRAINED";await atomic(queuePath,{version:1,updatedAt:finished,boundedConcurrency:1,batchSize:limit,mode:canary?"CANARY":"INCREMENTAL",completed});await atomic(checkpointPath,{lastFundId:completed.at(-1)?.fundId??cp.lastFundId??null,lastHoldingDate:completed.at(-1)?.currentDate??cp.lastHoldingDate??null,processedFunds:completed.length,observationsPersisted:completed.reduce((sum,item)=>sum+item.observations,0),lastSuccessfulRun:completed.length?finished:cp.lastSuccessfulRun??null,nextEligibleAt,status});await atomic(healthPath,{owner:"fund-style-drift",runnerPid:process.pid,lastHeartbeat:finished,scheduler,autoContinuing:scheduler,singleWriter:true,boundedConcurrency:1,status,completed:completed.length});await writeAssetRuntimeStatus("FUND",{CURRENT_LAYER:"P2",CURRENT_TASK:"Style Drift",LAST_PROGRESS_AT:finished,LAST_PROGRESS:completed.length?`Style Drift canary persisted and read back: ${completed[0].observations} observations for ${completed[0].fundId}`:"Style Drift INPUT_CONSTRAINED",CHECKPOINT:"runtime/global-fund/style-drift/checkpoint.json",NEXT_RUN_AT:nextEligibleAt,CONTINUING:"YES"});console.log(JSON.stringify({status,completed,nextEligibleAt}));
}
main().catch(async error=>{await atomic(healthPath,{owner:"fund-style-drift",runnerPid:process.pid,lastHeartbeat:iso(),scheduler,autoContinuing:scheduler,singleWriter:true,status:"RETRY_WAIT",lastError:error instanceof Error?error.message:String(error)});throw error;}).finally(()=>prisma.$disconnect());
