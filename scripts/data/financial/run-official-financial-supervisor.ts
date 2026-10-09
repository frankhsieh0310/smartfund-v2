import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Market="TWSE"|"TPEX"|"NASDAQ"|"NYSE"|"AMEX";
const market=process.argv.find(x=>x.startsWith("--market="))?.slice(9).toUpperCase() as Market|undefined;
if(!market||!["TWSE","TPEX","NASDAQ","NYSE","AMEX"].includes(market))throw new Error("MARKET_REQUIRED:TWSE_TPEX_NASDAQ_NYSE_AMEX");
const runtime=resolve("runtime","official-financial","children",market.toLowerCase());
const legacyRuntime=resolve("runtime","official-financial",market==="TWSE"||market==="TPEX"?"tw":"us");
const lockPath=resolve(runtime,"single-writer.lock"), heartbeatPath=resolve(runtime,"heartbeat.json"), schedulePath=resolve(runtime,"schedule.json");
const DAY_MS=86_400_000;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function put(path:string,value:unknown){await mkdir(runtime,{recursive:true});const tmp=`${path}.${process.pid}.tmp`;await writeFile(tmp,`${JSON.stringify(value,null,2)}\n`);await rename(tmp,path)}
async function readJson(path:string){try{return JSON.parse(await readFile(path,"utf8"));}catch{return null;}}
function run(script:string,args:string[]){return new Promise<number>((done,reject)=>{const child=spawn(process.execPath,["--experimental-strip-types",script,...args],{cwd:process.cwd(),stdio:"ignore",env:process.env,windowsHide:true});child.once("error",reject);child.once("exit",code=>done(code??1))})}
function command():[string,string[]]{return market==="TWSE"||market==="TPEX"
  ? ["scripts/data/financial/backfill-taiwan-official-financial.ts",["--apply","--resume","--incremental",`--markets=${market}`]]
  : ["scripts/data/financial/run-production-sec-financial.ts",[`--market=${market}`,"--incremental","--max-symbols=25"]];}
async function targetValue(){if(market==="TWSE"||market==="TPEX"){const cp=await readJson(resolve("runtime","official-financial","taiwan",market.toLowerCase(),"checkpoint-incremental.json"));return {processed:cp?.processedDocuments??null,rows:cp?.parsedFacts??null,checkpoint:cp?.lastSourceKey??null};}return {metric:`production_scheduler_checkpoints:official-financial-${market.toLowerCase()}-incremental`,checkpoint:"DATABASE_LIFECYCLE_PRESERVED"};}
async function main(){
  await mkdir(runtime,{recursive:true});let handle;
  try{handle=await open(lockPath,"wx");await handle.writeFile(JSON.stringify({market,pid:process.pid,startedAt:new Date().toISOString()}));}
  catch{const owner=await readJson(lockPath);try{if(owner?.pid)process.kill(Number(owner.pid),0);throw new Error(`OFFICIAL_FINANCIAL_${market}_SINGLE_WRITER_ACTIVE:${owner?.pid??"UNKNOWN"}`);}catch(error){if(error instanceof Error&&error.message.includes("SINGLE_WRITER_ACTIVE"))throw error;await rm(lockPath,{force:true});handle=await open(lockPath,"wx");await handle.writeFile(JSON.stringify({market,pid:process.pid,startedAt:new Date().toISOString(),recoveredStalePid:owner?.pid??null}));}}
  const release=async()=>{await handle?.close().catch(()=>undefined);await rm(lockPath,{force:true}).catch(()=>undefined);};
  process.once("SIGTERM",()=>{void release().finally(()=>process.exit(0));});process.once("SIGINT",()=>{void release().finally(()=>process.exit(0));});
  try{
    const own=await readJson(schedulePath),legacy=await readJson(resolve(legacyRuntime,"heartbeat.json"));
    let nextRunAt=own?.nextRunAt??new Date(Math.max(Date.now(),Date.parse(legacy?.heartbeatAt??"")+DAY_MS)).toISOString();
    for(;;){
      const metric=await targetValue();
      await put(heartbeatPath,{asset:`OFFICIAL_FINANCIAL_${market}`,market,pid:process.pid,alive:true,status:"SCHEDULED_WAIT",heartbeatAt:new Date().toISOString(),nextRunAt,targetMetric:market==="TWSE"||market==="TPEX"?"processedDocuments/parsedFacts/lastSourceKey":"production_scheduler_checkpoints.processed/succeeded/last_symbol",targetValue:metric,publicationCadence:"DAILY_FILING_AWARE",autoContinuing:true});
      await put(schedulePath,{market,status:"SCHEDULED_WAIT",nextRunAt,updatedAt:new Date().toISOString()});
      await sleep(Math.max(60_000,Date.parse(nextRunAt)-Date.now()));
      const [script,args]=command();await put(heartbeatPath,{asset:`OFFICIAL_FINANCIAL_${market}`,market,pid:process.pid,alive:true,status:"INCREMENTAL_RUNNING",heartbeatAt:new Date().toISOString(),script,args,targetValue:metric});
      const code=await run(script,args);const current=await targetValue();nextRunAt=new Date(Date.now()+DAY_MS).toISOString();
      await put(resolve(runtime,"last-run.json"),{market,script,args,exitCode:code,previousTarget:metric,currentTarget:current,finishedAt:new Date().toISOString(),nextRunAt});
    }
  }finally{await release();}
}
main().catch(async e=>{await put(resolve(runtime,"fatal.json"),{market,pid:process.pid,error:e instanceof Error?e.message:String(e),at:new Date().toISOString()});process.exitCode=1});
