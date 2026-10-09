import { PrismaClient } from "@prisma/client";
import { load } from "cheerio";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeAssetRuntimeStatus } from "../runtime-status/write-asset-runtime-status.ts";
import { enrichMoneyDjPublicProfile } from "./enrich-moneydj-public-profile.ts";

type Work={fundId:string;moneydjCode:string;fundName:string};
function configureMoneyDjWriteConnection(){const value=process.env.DATABASE_URL;if(!value)return;const url=new URL(value);url.searchParams.set("options","-c default_transaction_read_only=off");process.env.DATABASE_URL=url.toString();}
configureMoneyDjWriteConnection();
const prisma=new PrismaClient(),runtime=resolve("runtime/global-fund/lifecycle-manager"),source="MONEYDJ_PUBLIC_FUND_PROFILE";
const canary=process.argv.includes("--canary"),scheduler=process.env.FUND_LIFECYCLE_MANAGER_SCHEDULER==="1",limit=canary?1:5,iso=()=>new Date().toISOString();
async function atomic(name:string,value:unknown){const file=resolve(runtime,name);await mkdir(dirname(file),{recursive:true});const temp=`${file}.${process.pid}.${Date.now()}.tmp`;await writeFile(temp,`${JSON.stringify(value,null,2)}\n`);await rename(temp,file);}
async function items():Promise<Work[]>{if(canary)return[{fundId:"016e165f-090e-47c7-9223-aba1bde5d498",moneydjCode:"TLZH6",fundName:"Allianz American Income - BT - USD"}];return prisma.$queryRawUnsafe<Work[]>(`SELECT f.id AS "fundId",m.moneydj_code AS "moneydjCode",f.name AS "fundName" FROM fund_mappings m JOIN funds f ON f.id=m.fund_id WHERE m.moneydj_code IS NOT NULL ORDER BY COALESCE((SELECT MAX(p.updated_at) FROM fund_profile_provenance p WHERE p.fund_id=f.id AND p.field_name='MONEYDJ_FIELD_COMPLETENESS_EVALUATED'),'1970-01-01') ASC,f.id LIMIT $1`,limit);}
async function evidence(item:Work){
  const url=`https://b2bfundrwd.moneydj.com/w/wb/wb01.djhtm?a=${encodeURIComponent(item.moneydjCode)}-${encodeURIComponent(item.moneydjCode)}`;
  const response=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 SmartFund Fund Research/1.0"},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`BLOCKED_SOURCE:MONEYDJ_HTTP_${response.status}`);
  const html=new TextDecoder("big5").decode(await response.arrayBuffer()),body=load(html)("body").text().replace(/\s+/g," ");
  const launch=body.match(/基金成立日\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]?.replaceAll("/","-")??null;
  const managerText=body.match(/基金經理人\s*([^\n]+?)(?:基金規模|計價幣別|$)/)?.[1]?.trim()??null;
  return{url,launch,managers:managerText?managerText.split("/").map(x=>x.trim()).filter(Boolean):[]};
}
async function main(){
  const work=await items(),completed:any[]=[],constrained:any[]=[],failed:any[]=[];
  for(const item of work)try{
    const mapped=await prisma.$queryRawUnsafe<any[]>(`SELECT 1 FROM fund_mappings WHERE fund_id=$1 AND moneydj_code=$2`,item.fundId,item.moneydjCode);if(!mapped[0])throw new Error("MAPPING_CONSTRAINED:CANONICAL_MAPPING_MISSING");
    const ev=await evidence(item);let lifecycle=0,managerRows=0;
    const enrichment=await prisma.$transaction(async tx=>{
      const lock=await tx.$queryRawUnsafe<any[]>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:fund-lifecycle-manager:v1')) locked`);if(!lock[0]?.locked)throw new Error("BLOCKED_OWNERSHIP:FUND_LIFECYCLE_MANAGER_LOCKED");
      const enriched=await enrichMoneyDjPublicProfile(tx,item);
      if(ev.launch){const official=await tx.$queryRawUnsafe<any[]>(`SELECT id FROM fund_events WHERE fund_id=$1 AND event_type='LAUNCH' AND verification_status='VERIFIED' AND source<>$2 LIMIT 1`,item.fundId,source);if(!official[0]){lifecycle+=await tx.$executeRawUnsafe(`INSERT INTO fund_events(id,fund_id,share_class_id,event_type,effective_date,source,source_record_id,verification_status,created_at,updated_at) VALUES($1,$2,NULL,'LAUNCH',$3::date,$4,$5,'VERIFIED_SUPPLEMENTAL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(fund_id,share_class_id,event_type,effective_date,source,source_record_id) DO NOTHING`,randomUUID(),item.fundId,ev.launch,source,`${item.moneydjCode}:launch:${ev.launch}`);}}
      for(const name of ev.managers){let manager=(await tx.$queryRawUnsafe<any[]>(`SELECT id FROM fund_managers WHERE name=$1 AND source=$2 LIMIT 1`,name,source))[0];if(!manager){await tx.$executeRawUnsafe(`INSERT INTO fund_managers(id,name,source,source_record_id,verification_status,created_at,updated_at) VALUES($1,$2,$3,$4,'VERIFIED_SUPPLEMENTAL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(name,source) DO NOTHING`,randomUUID(),name,source,`${item.moneydjCode}:manager:${name}`);manager=(await tx.$queryRawUnsafe<any[]>(`SELECT id FROM fund_managers WHERE name=$1 AND source=$2 LIMIT 1`,name,source))[0];}const exists=await tx.$queryRawUnsafe<any[]>(`SELECT id FROM fund_manager_assignments WHERE manager_id=$1 AND fund_id=$2 AND role='PORTFOLIO_MANAGER' AND source=$3 AND end_date IS NULL LIMIT 1`,manager.id,item.fundId,source);if(!exists[0])managerRows+=await tx.$executeRawUnsafe(`INSERT INTO fund_manager_assignments(id,manager_id,fund_id,share_class_id,role,source,source_record_id,verified_at,created_at,updated_at) VALUES($1,$2,$3,NULL,'PORTFOLIO_MANAGER',$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,randomUUID(),manager.id,item.fundId,source,`${item.moneydjCode}:current-manager:${name}`);}
      await tx.$executeRawUnsafe(`INSERT INTO fund_profile_provenance(id,fund_id,share_class_id,field_name,source,source_record_id,as_of_date,verification_status,grain,created_at,updated_at) VALUES($1,$2,NULL,'MONEYDJ_FIELD_COMPLETENESS_EVALUATED',$3,$4,CURRENT_DATE,'VERIFIED_SUPPLEMENTAL','FUND_LEVEL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(fund_id,share_class_id,field_name,source,source_record_id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP`,randomUUID(),item.fundId,source,`${item.moneydjCode}:field-completeness`);
      return enriched;
    },{maxWait:10000,timeout:60000});
    completed.push({...item,launchDate:ev.launch,managerNames:ev.managers,lifecycleObservations:lifecycle,managerObservations:managerRows,profileObservations:enrichment.persisted,profileReadback:enrichment.readback,profileFields:enrichment.fields,sourceUrl:ev.url});
  }catch(error){const message=error instanceof Error?error.message:String(error);(message.includes("SOURCE_NOT_PUBLIC")?constrained:failed).push({fundId:item.fundId,error:message});}
  const now=iso(),persisted=completed.reduce((n,r)=>n+r.lifecycleObservations+r.managerObservations+r.profileObservations,0),status=completed.length?"CURRENT":failed.length?"RETRY_WAIT":"INPUT_CONSTRAINED",nextEligibleAt=new Date(Date.now()+86400000).toISOString();
  await atomic("queue.json",{version:2,updatedAt:now,boundedConcurrency:1,batchSize:limit,fullUniverseAssigned:true,fullHistoryAssigned:true,completed,constrained,failed});await atomic("checkpoint.json",{lastFundId:completed.at(-1)?.fundId??null,lastMoneydjCode:completed.at(-1)?.moneydjCode??null,processedFunds:completed.length,observationsPersisted:persisted,lastSuccessfulRun:completed.length?now:null,nextEligibleAt,status,lastError:failed.at(-1)?.error??null,fieldRegistry:"runtime/global-fund/moneydj-public-layer/field-registry.json"});await atomic("health.json",{owner:"fund-lifecycle-manager",runnerPid:process.pid,lastHeartbeat:now,scheduler,autoContinuing:true,singleWriter:true,boundedConcurrency:1,status});
  await writeAssetRuntimeStatus("FUND",{CURRENT_LAYER:"MONEYDJ_FUND_PUBLIC_DATA_LAYER",CURRENT_TASK:"Field Completeness",CURRENT_SOURCE:source,LAST_PROGRESS_AT:now,LAST_PROGRESS:`MoneyDJ field enrichment: ${persisted} observations persisted`,CHECKPOINT:"runtime/global-fund/lifecycle-manager/checkpoint.json",NEXT:"BACKGROUND_CONTINUE_FULL_UNIVERSE_HISTORY",NEXT_RUN_AT:nextEligibleAt,CONTINUING:"YES"});
  if(scheduler)spawnSync(process.execPath,["--experimental-strip-types","--env-file=.env","scripts/data/global-fund/run-fund-dated-disclosure.ts"],{cwd:process.cwd(),windowsHide:true,stdio:"ignore",env:{...process.env,FUND_DATED_DISCLOSURE_SCHEDULER:"1"}});
  if(scheduler)spawnSync(process.execPath,["--experimental-strip-types","--env-file=.env","scripts/data/global-fund/run-fund-public-data-mesh.ts"],{cwd:process.cwd(),windowsHide:true,stdio:"ignore",env:process.env});
  if(scheduler)spawnSync(process.execPath,["--experimental-strip-types","--env-file=.env","scripts/data/global-fund/run-fund-background-public-expansion.ts"],{cwd:process.cwd(),windowsHide:true,stdio:"ignore",env:process.env});
  console.log(JSON.stringify({status,completed,constrained,failed,persisted,nextEligibleAt}));if(failed.length&&!completed.length)process.exitCode=1;
}
main().finally(()=>prisma.$disconnect());
