import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { deterministicMasterKey, portfolioKey, providerKey } from "./services/fund-holdings-resolution.ts";

const engine=path.resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if(process.platform==="win32"&&!process.env.PRISMA_QUERY_ENGINE_LIBRARY)process.env.PRISMA_QUERY_ENGINE_LIBRARY=engine;
const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}});

type Fund={id:string;isin:string|null;name:string;legal_name:string|null;name_en:string|null;company:string;currency:string};
type Product={id:string;moneydj_code:string;product_name:string;currency:string|null;raw_payload:Record<string,unknown>|null};

function isinMatches(product:Product,isins:Set<string>){
 if(!isins.size)return false;
 return Object.values(product.raw_payload??{}).some(value=>isins.has(String(value).trim().toUpperCase()));
}

async function main(){
 const [funds,products,mappings]=await Promise.all([
  db.$queryRawUnsafe<Fund[]>(`SELECT id,isin,name,legal_name,name_en,company,currency FROM funds WHERE is_active=true ORDER BY id`),
  db.$queryRawUnsafe<Product[]>(`SELECT id::text,moneydj_code,product_name,currency,raw_payload FROM moneydj_external_products WHERE moneydj_code IS NOT NULL AND moneydj_code<>'1' ORDER BY moneydj_code`),
  db.$queryRawUnsafe<Array<{fund_id:string}>>(`SELECT fund_id FROM fund_mappings WHERE moneydj_code IS NOT NULL AND moneydj_code<>'1'`),
 ]);
 const groups=new Map<string,Fund[]>();for(const fund of funds){const key=deterministicMasterKey(fund);groups.set(key,[...(groups.get(key)??[]),fund])}
 const byId=new Map(funds.map(fund=>[fund.id,fund])),mappedKeys=new Set(mappings.flatMap(row=>{const fund=byId.get(row.fund_id);return fund?[deterministicMasterKey(fund)]:[]}));
 const remaining=[...groups.entries()].filter(([key])=>!mappedKeys.has(key));let newlyMapped=0,ambiguous=0;
 for(const [masterKey,members] of remaining){
  const representative=[...members].sort((a,b)=>a.id.localeCompare(b.id))[0];
  const isins=new Set(members.flatMap(fund=>fund.isin?[fund.isin.trim().toUpperCase()]:[]));
  const cores=new Set(members.flatMap(fund=>[portfolioKey(fund.legal_name||fund.name),portfolioKey(fund.name_en)].filter(Boolean)));
  const provider=providerKey(representative.company);
  let candidates=products.filter(product=>isinMatches(product,isins));let method="MASTER_ISIN_EXACT";
  if(!candidates.length){candidates=products.filter(product=>cores.has(portfolioKey(product.product_name))&&(!provider||providerKey(product.product_name).includes(provider)));method="MASTER_PROVIDER_PORTFOLIO_NAME_EXACT"}
  if(!candidates.length){const all=products.filter(product=>cores.has(portfolioKey(product.product_name)));const portfolios=new Set(all.map(product=>portfolioKey(product.product_name)).filter(Boolean));if(portfolios.size===1)candidates=all;method="MASTER_PORTFOLIO_NAME_EXACT"}
  const portfolioIdentities=new Map<string,Product[]>();for(const product of candidates){const key=portfolioKey(product.product_name);portfolioIdentities.set(key,[...(portfolioIdentities.get(key)??[]),product])}
  if(portfolioIdentities.size!==1){if(portfolioIdentities.size>1)ambiguous++;continue}
  const identity=[...portfolioIdentities.values()][0].sort((a,b)=>a.moneydj_code.localeCompare(b.moneydj_code))[0];
  await db.$transaction([
   db.$executeRawUnsafe(`INSERT INTO fund_mappings(id,fund_id,moneydj_code,status,candidate_count,last_checked_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,NOW(),NOW(),NOW()) ON CONFLICT(fund_id) DO UPDATE SET moneydj_code=EXCLUDED.moneydj_code,status=EXCLUDED.status,candidate_count=EXCLUDED.candidate_count,last_checked_at=NOW(),updated_at=NOW()`,randomUUID(),representative.id,identity.moneydj_code,method,candidates.length),
   db.$executeRawUnsafe(`UPDATE moneydj_external_products SET canonical_fund_id=$2,mapping_status='EXACT_MASTER_MAPPED',updated_at=NOW() WHERE id=$1::uuid AND (canonical_fund_id IS NULL OR canonical_fund_id=$2)`,identity.id,representative.id),
  ]);
  mappedKeys.add(masterKey);newlyMapped++;
 }
 console.log(JSON.stringify({masters:groups.size,searched:remaining.length,newlyMapped,stillUnmapped:remaining.length-newlyMapped,ambiguous,mappedAfter:mappedKeys.size,mappingRate:Number((mappedKeys.size*100/groups.size).toFixed(2))}));
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>db.$disconnect());
