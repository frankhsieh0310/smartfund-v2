import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root=process.cwd(), runtime=path.join(root,"runtime","etf-identity-routing");
const cfg=JSON.parse(await fs.readFile(path.join(root,"config","etf-regulatory-identity-routing.json"),"utf8"));
const once=process.argv.includes("--once"), continuous=process.argv.includes("--continuous");
const prisma=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL}}});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"))}catch{return fallback}}
async function atomic(file:string,value:unknown){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(value,null,2)+"\n");await fs.rename(tmp,file)}
async function main(){
 await fs.mkdir(path.join(runtime,"batches"),{recursive:true}); const lock=path.join(runtime,"worker.lock");
 try{await fs.writeFile(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:"wx"})}catch{throw new Error("ETF_IDENTITY_ROUTER_ALREADY_RUNNING")}
 try{
  const issuer=await prisma.$queryRawUnsafe<any[]>(`INSERT INTO etf_issuers(id,code,official_name,official_url,source_status,verification_status,license_status,created_at,updated_at) VALUES($1::uuid,'blackrock','BlackRock / iShares','https://www.ishares.com/us/products/etf-investments','PUBLIC_OFFICIAL','VERIFIED_OFFICIAL','PUBLIC_OFFICIAL_REVIEW_REQUIRED',NOW(),NOW()) ON CONFLICT(code) DO UPDATE SET updated_at=NOW() RETURNING id`,randomUUID());
  for(const p of cfg.products) await prisma.$executeRawUnsafe(`INSERT INTO etf_issuer_mappings(etf_id,issuer_id,source,verification_status,created_at,updated_at) SELECT id,$1::uuid,$2,'VERIFIED_OFFICIAL',NOW(),NOW() FROM etfs WHERE UPPER(code)=$3 ON CONFLICT(etf_id) DO UPDATE SET issuer_id=EXCLUDED.issuer_id,source=EXCLUDED.source,verification_status=EXCLUDED.verification_status,updated_at=NOW()`,issuer[0].id,`Official iShares product mapping; portfolioId=${p.portfolioId}; slug=${p.slug}`,p.code);
  let cp=await read(path.join(runtime,"checkpoint.json"),{cursor:null,batches:0,evaluated:0});
  do{
   const rows=await prisma.$queryRawUnsafe<any[]>(`SELECT e.id,e.code,e.exchange,e.provider,e.isin,(SELECT COUNT(*)::int FROM etfs x WHERE x.code=e.code AND COALESCE(x.exchange,'')=COALESCE(e.exchange,'')) listing_count,m.verification_status issuer_mapping FROM etfs e LEFT JOIN etf_issuer_mappings m ON m.etf_id=e.id WHERE ($1::text IS NULL OR e.id>$1) ORDER BY e.id LIMIT $2`,cp.cursor,cfg.batchSize);
   if(!rows.length){cp={...cp,state:"COMPLETE_AS_AVAILABLE",nextRunAt:null,updatedAt:new Date().toISOString()};await atomic(path.join(runtime,"checkpoint.json"),cp);break}
   const items=rows.map((e:any)=>{const product=cfg.products.find((p:any)=>p.code===e.code);const ambiguous=e.listing_count!==1;const verified=!ambiguous&&Boolean(e.isin||product);const state=ambiguous?"AMBIGUOUS":verified?"VERIFIED_IDENTITY":e.exchange?"PARTIAL_IDENTITY":"IDENTITY_MISSING";return {etfId:e.id,code:e.code,exchange:e.exchange,isin:e.isin,cusip:null,sedol:null,cik:null,seriesId:null,classId:null,issuerProductId:product?.portfolioId??null,officialProductRoute:product?`https://www.ishares.com/us/products/${product.portfolioId}/${product.slug}`:null,identityState:state,providerRoute:product?"ROUTING_RETRY_ELIGIBLE":"SOURCE_LIMITED",mappingRule:product?"EXISTING_OFFICIAL_PRODUCT_ID_PLUS_UNIQUE_CANONICAL_CODE":e.isin?"EXACT_ISIN":"UNIQUE_TICKER_EXCHANGE_PARTIAL"}});
   const last=rows.at(-1).id; await atomic(path.join(runtime,"batches",`${rows[0].id}--${last}.json`),{createdAt:new Date().toISOString(),items});
   await atomic(path.join(runtime,"routing-retry-handoff.json"),{state:"READY_FOR_EXISTING_EXPANSION_LIFECYCLE",updatedAt:new Date().toISOString(),items:items.filter((x:any)=>x.providerRoute==="ROUTING_RETRY_ELIGIBLE").map((x:any)=>({etfId:x.etfId,code:x.code,issuerProductId:x.issuerProductId}))});
   cp={...cp,cursor:last,batches:cp.batches+1,evaluated:cp.evaluated+rows.length,state:"RUNNING",processId:process.pid,updatedAt:new Date().toISOString(),nextRunAt:new Date(Date.now()+5000).toISOString()}; await atomic(path.join(runtime,"checkpoint.json"),cp);
   if(once||!continuous)break; await sleep(5000);
  }while(true)
  const s=await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int universe,COUNT(*) FILTER(WHERE isin IS NOT NULL)::int isin,COUNT(*) FILTER(WHERE isin IS NOT NULL OR id IN(SELECT etf_id FROM etf_issuer_mappings WHERE verification_status='VERIFIED_OFFICIAL'))::int verified,COUNT(*) FILTER(WHERE isin IS NULL AND exchange IS NOT NULL AND id NOT IN(SELECT etf_id FROM etf_issuer_mappings WHERE verification_status='VERIFIED_OFFICIAL'))::int partial,COUNT(*) FILTER(WHERE isin IS NULL AND exchange IS NULL AND id NOT IN(SELECT etf_id FROM etf_issuer_mappings WHERE verification_status='VERIFIED_OFFICIAL'))::int missing,(SELECT COUNT(*)::int FROM etf_issuer_mappings WHERE verification_status='VERIFIED_OFFICIAL') issuer_product_id FROM etfs`);
  await atomic(path.join(runtime,"summary.json"),{...s[0],cusip:0,sedol:0,cik:0,seriesId:0,classId:0,sec_mapped:0,ambiguous:0,nportRedownloaded:false,databaseWritten:"ETF_ISSUER_MAPPINGS_ONLY",updatedAt:new Date().toISOString()});
 }finally{await prisma.$disconnect();await fs.unlink(lock).catch(()=>{})}
}
main().catch(e=>{console.error(e);process.exitCode=1});
