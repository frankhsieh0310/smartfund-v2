import { spawn } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { deterministicMasterKey } from "../global-fund/services/fund-holdings-resolution.ts";

const engine=path.resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if(process.platform==="win32"&&!process.env.PRISMA_QUERY_ENGINE_LIBRARY)process.env.PRISMA_QUERY_ENGINE_LIBRARY=engine;
const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}});
const batchSize=Number(process.argv.find(x=>x.startsWith("--batch-size="))?.slice(13)??"500");

function run(offset:number){return new Promise<{attempted:number;success:number;failed:number}>((done,reject)=>{
 const child=spawn(process.execPath,["--experimental-strip-types","--env-file=.env","scripts/data/global-fund/run-moneydj-full-holdings-allocation.ts",`--limit=${batchSize}`,`--offset=${offset}`,"--concurrency=25","--master-only"],{cwd:process.cwd(),windowsHide:true});
 let output="";child.stdout.on("data",value=>output+=String(value));child.stderr.on("data",value=>process.stderr.write(value));child.on("error",reject);child.on("exit",code=>{if(code!==0)return reject(new Error(`FUND_MASTER_BATCH_EXIT_${code}`));const match=output.match(/SUMMARY=(\{[^\n]+\})/);if(!match)return reject(new Error("FUND_MASTER_SUMMARY_MISSING"));const result=JSON.parse(match[1]);done({attempted:result.attempted,success:result.partial,failed:result.failed})});
})}

async function main(){
 const funds=await db.$queryRawUnsafe<Array<{id:string;company:string;name:string;legal_name:string|null;name_en:string|null}>>(`SELECT id,company,name,legal_name,name_en FROM funds WHERE is_active=true`);
 const masters=new Set(funds.map(deterministicMasterKey)).size;
 const mapped=await db.$queryRawUnsafe<Array<{company:string;name:string;legal_name:string|null;name_en:string|null}>>(`SELECT f.company,f.name,f.legal_name,f.name_en FROM fund_mappings m JOIN funds f ON f.id=m.fund_id WHERE m.moneydj_code IS NOT NULL AND m.moneydj_code<>'1' AND f.is_active=true`);
 const eligible=new Set(mapped.map(deterministicMasterKey)).size;let attempted=0,success=0,failed=0;
 for(let offset=0;offset<eligible;offset+=batchSize){const result=await run(offset);attempted+=result.attempted;success+=result.success;failed+=result.failed}
 console.log(JSON.stringify({pipeline:"FUND_MASTER_HOLDINGS_UPDATE",masters,eligible,attempted,success,failed}));
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>db.$disconnect());
