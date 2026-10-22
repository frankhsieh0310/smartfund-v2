import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const db = new PrismaClient({ datasources: { db: { url: process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER ?? process.env.DATABASE_URL } } });
const runtimeDir = resolve("runtime/global-fund/source-reported-allocation");
async function atomic(name:string,value:unknown){await mkdir(runtimeDir,{recursive:true});const file=resolve(runtimeDir,name),temporary=`${file}.${process.pid}.tmp`;await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`);await rename(temporary,file)}
async function child(){await new Promise<void>((ok,bad)=>{const processChild=spawn(process.execPath,["--import","tsx","--env-file=.env","scripts/data/global-fund/run-moneydj-full-holdings-allocation.ts"],{cwd:process.cwd(),env:process.env,stdio:"inherit"});processChild.once("error",bad);processChild.once("exit",code=>code===0?ok():bad(new Error(`MONEYDJ_FULL_EXTRACTION_EXIT_${code}`)))})}
async function main(){
 const query=(sql:string,...args:any[])=>db.$queryRawUnsafe<any[]>(sql,...args);
 const [verified]=await query(`SELECT count(DISTINCT fund_id)::int funds,count(DISTINCT share_class_id) FILTER(WHERE share_class_id IS NOT NULL)::int classes FROM fund_provider_mappings WHERE verified_at IS NOT NULL`);
 const [mapped]=await query(`SELECT (SELECT count(DISTINCT fund_id)::int FROM fund_mappings WHERE moneydj_code IS NOT NULL) moneydj,(SELECT count(DISTINCT fund_id)::int FROM fund_provider_mappings WHERE provider='YAHOO' AND verified_at IS NOT NULL) yahoo,(SELECT count(DISTINCT fund_id)::int FROM fund_documents WHERE source IN('AB_OFFICIAL_DOCUMENTS','FRANKLIN_TW_OFFICIAL_DOCUMENTS','SCHRODERS_OFFICIAL_DOCUMENTS')) official`);
 const [top]=await query(`SELECT count(*)::int rows,count(DISTINCT fund_id)::int funds,count(*) FILTER(WHERE rank<=5)::int top5,count(*) FILTER(WHERE rank<=10)::int top10,count(*) FILTER(WHERE rank<=20)::int top20,min(as_of_date) earliest,max(as_of_date) latest FROM holdings WHERE source='MONEYDJ_PUBLIC_DISCLOSURE'`);
 const [allocation]=await query(`SELECT count(*)::int rows,count(DISTINCT fund_id)::int funds FROM fund_source_allocation_observations WHERE source='MONEYDJ_PUBLIC_DISCLOSURE'`);
 const now=new Date().toISOString();
 const checkpoint={version:2,ownerPid:Number(process.env.SMARTFUND_SUPERVISOR_PID??23196),childProcessId:process.pid,state:"RUNNING",heartbeat:now,lastSuccess:now,nextRunAt:new Date(Date.now()+86_400_000).toISOString(),checkpointActive:true,resumable:true,autoContinuing:true,verifiedFunds:verified.funds,verifiedShareClasses:verified.classes,sourceEligibleFunds:mapped.moneydj+mapped.yahoo+mapped.official,sourceEligibleShareClasses:verified.classes,mappings:mapped,allocationRows:allocation.rows,allocationFunds:allocation.funds,derivedRows:0,holdingDerivedRows:0,topHoldings:top};
 await atomic("checkpoint.json",checkpoint);await atomic("source-disposition.json",checkpoint);
 await child();
 checkpoint.state="SCHEDULED_WAIT";checkpoint.heartbeat=new Date().toISOString();checkpoint.lastSuccess=checkpoint.heartbeat;
 await atomic("checkpoint.json",checkpoint);await atomic("source-disposition.json",checkpoint);console.log(JSON.stringify(checkpoint));
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>db.$disconnect());
