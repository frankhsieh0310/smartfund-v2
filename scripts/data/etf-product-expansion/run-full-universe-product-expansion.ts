import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root=process.cwd(), runtime=path.join(root,"runtime","etf-product-expansion"), configPath=path.join(root,"config","etf-full-universe-product-expansion.json");
const continuous=process.argv.includes("--continuous"), once=process.argv.includes("--once");
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"))}catch{return fallback}}
async function atomic(file:string,value:unknown){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(value,null,2)+"\n");await fs.rename(tmp,file)}
function classify(etf:any,cfg:any){
  const exactIssuer=cfg.exactIssuerProviders.includes(etf.provider), hasIsin=Boolean(etf.isin), hasListing=Boolean(etf.code&&etf.exchange);
  const holdingsOwned=cfg.existingHoldingsOwner.codes.includes(etf.code), flowOwned=cfg.existingFlowCodes.includes(etf.code);
  const identityState=hasIsin?"EXACT_ISIN":hasListing?"LISTING_ONLY_IDENTITY_MISSING_REGULATORY_KEYS":"IDENTITY_MISSING";
  const sourceState=holdingsOwned?"EXISTING_HOLDINGS_OWNER":exactIssuer?"SOURCE_LIMITED_MISSING_PER_PRODUCT_ROUTE":etf.provider==="未知（待補）"?"IDENTITY_MISSING":"SOURCE_LIMITED_NO_COMMON_PRODUCT_ADAPTER";
  return {key:`ETF_PRODUCT_EXPANSION:${etf.id}`,etfId:etf.id,code:etf.code,exchange:etf.exchange,provider:etf.provider,isin:etf.isin,identityState,sourceState,holdingsState:holdingsOwned?"DELEGATED_EXISTING_PID":"PENDING_ELIGIBILITY",flowState:flowOwned?"DELEGATED_EXISTING_FLOW_LIFECYCLE":"PENDING_ELIGIBILITY",nportState:hasIsin?"EXACT_MAPPING_CHECK_REQUIRED":"IDENTITY_BLOCKED",rawPreservation:"REQUIRED",action:sourceState.startsWith("SOURCE_LIMITED")||sourceState==="IDENTITY_MISSING"?"RECORD_SKIP_CONTINUE":"ROUTE_EXISTING_OWNER"};
}
async function main(){
  const cfg=await read(configPath,null);if(!cfg)throw new Error("EXPANSION_CONFIG_MISSING");await fs.mkdir(runtime,{recursive:true});
  const lock=path.join(runtime,"worker.lock");try{await fs.writeFile(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:"wx"})}catch{throw new Error("ETF_PRODUCT_EXPANSION_ALREADY_RUNNING")}
  const prisma=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL}}});
  try{
    let checkpoint=await read(path.join(runtime,"checkpoint.json"),{cursor:null,batches:0,evaluated:0,state:"STARTING"});
    do{
      const rows=await prisma.$queryRawUnsafe<any[]>(`SELECT id,code,exchange,provider,isin,currency,region FROM etfs WHERE ($1::text IS NULL OR id>$1) ORDER BY id LIMIT $2`,checkpoint.cursor,cfg.batchSize);
      if(!rows.length){checkpoint={...checkpoint,state:"COMPLETE_AS_AVAILABLE",processId:process.pid,updatedAt:new Date().toISOString(),nextRunAt:null};await atomic(path.join(runtime,"checkpoint.json"),checkpoint);break}
      const items=rows.map(row=>classify(row,cfg)), first=rows[0].id,last=rows.at(-1).id;
      await atomic(path.join(runtime,"batches",`${first}--${last}.json`),{first,last,items,createdAt:new Date().toISOString()});
      checkpoint={...checkpoint,state:"RUNNING",processId:process.pid,cursor:last,batches:Number(checkpoint.batches||0)+1,evaluated:Number(checkpoint.evaluated||0)+rows.length,failed:Number(checkpoint.failed||0),sourceLimited:Number(checkpoint.sourceLimited||0)+items.filter((x:any)=>x.sourceState.startsWith("SOURCE_LIMITED")).length,identityBlocked:Number(checkpoint.identityBlocked||0)+items.filter((x:any)=>x.identityState.includes("MISSING")).length,updatedAt:new Date().toISOString(),nextRunAt:new Date(Date.now()+5000).toISOString()};
      await atomic(path.join(runtime,"checkpoint.json"),checkpoint);
      if(once||!continuous)break;await sleep(5000);
    }while(true)
    await atomic(path.join(runtime,"worker-status.json"),{asset:cfg.asset,pid:process.pid,state:checkpoint.state,checkpoint:path.join(runtime,"checkpoint.json"),resumable:true,failSoft:true,batchSize:cfg.batchSize,maxDbConcurrency:1,existingHoldingsPipelineTouched:false,priority0Touched:false,priority9Touched:false,updatedAt:new Date().toISOString()});
    console.log(JSON.stringify(checkpoint));
  }finally{await prisma.$disconnect();await fs.unlink(path.join(runtime,"worker.lock")).catch(()=>{})}
}
main().catch(error=>{console.error(error);process.exitCode=1});
