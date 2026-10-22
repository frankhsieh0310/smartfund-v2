import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const engine=path.resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if(process.platform==="win32"&&!process.env.PRISMA_QUERY_ENGINE_LIBRARY)process.env.PRISMA_QUERY_ENGINE_LIBRARY=engine;
const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}});
const limit=Number(process.argv.find(x=>x.startsWith("--limit="))?.slice(8)??"100");
const offset=Number(process.argv.find(x=>x.startsWith("--offset="))?.slice(9)??"0");
const write=process.argv.includes("--write");
const onlyUnmapped=process.argv.includes("--only-unmapped");

const noise=[/\(未申報生效\)/g,/\(已撤銷核備\)/g,/\(本基金[^)]*\)/g,/（本基金[^）]*）/g,/基金之配息來源可能為本金/g,/本基金配息來源可能為本金/g];
function norm(value:string|null|undefined){let s=(value??"").normalize("NFKC").toLowerCase();for(const r of noise)s=s.replace(r,"");return s.replace(/[\s\-‐‑–—_─－·•,，.。()（）/／:：'"「」『』]/g,"").replace(/臺/g,"台")}
function secondNorm(value:string|null|undefined){
 let s=(value??"").normalize("NFKC").toLowerCase();for(const r of noise)s=s.replace(r,"");
 s=s.replace(/新臺幣|新台幣|臺幣|台幣|twd/g,"幣twd")
  .replace(/美元|美金|usd/g,"幣usd").replace(/歐元|eur/g,"幣eur")
  .replace(/澳幣|aud/g,"幣aud").replace(/南非幣|zar/g,"幣zar")
  .replace(/離岸人民幣|人民幣|cn[hy]/g,"幣cny")
  .replace(/未避險|不避險|非避險|unhedged/g,"unhedged")
  .replace(/避險|對沖|hedged/g,"hedged")
  .replace(/累積型|累積類型|累積股|不配息|不分配|累積|accumulating|acc\b/g,"acc")
  .replace(/每月配息|每月分配|月收益|月配息型|月配型|穩定月配股|配息型|分配型|monthlydistribution|distribution|dist\b/g,"dist")
  .replace(/安聯環球投資基金|allianzglobalinvestors/g,"安聯")
  .replace(/貝萊德全球基金|blackrockglobalfunds/g,"貝萊德")
  .replace(/富達基金|fidelityfunds/g,"富達")
  .replace(/摩根基金|jpmorganfunds/g,"摩根")
  .replace(/施羅德環球基金系列|schroderinternationalselectionfund/g,"施羅德")
  .replace(/級別|股份|股別|類型|類別/g,"")
  .replace(/環球基金系列|全球投資系列/g,"");
 return s.replace(/[\s\-‐‑–—_─－·•,，.。()（）/／:：'"「」『』]/g,"").replace(/臺/g,"台");
}
function legalNorm(value:string|null|undefined){
 return secondNorm(value)
  .replace(/soci[eé]t[eé]dinvestissement[aà]capitalvariable|sicav/g,"fund")
  .replace(/publiclimitedcompany|plc|limited|ltd|incorporated|inc/g,"")
  .replace(/investmentfunds?|mutualfunds?|證券投資信託基金|共同基金|基金/g,"fund")
  .replace(/第([ivx]+)期/g,"$1");
}
function currencyNorm(value:string|null|undefined){return secondNorm(value).replace(/^幣/,"")}

async function main(){
 const [funds,products,aliases]=await Promise.all([
  db.$queryRawUnsafe<any[]>(`SELECT id,isin,name,legal_name,name_en,company,currency FROM funds f WHERE is_active=true AND ($3::boolean=false OR NOT EXISTS(SELECT 1 FROM fund_mappings m WHERE m.fund_id=f.id AND m.moneydj_code IS NOT NULL AND m.moneydj_code<>'1')) ORDER BY id OFFSET $1 LIMIT $2`,offset,limit,onlyUnmapped),
  db.$queryRawUnsafe<any[]>(`SELECT id::text,moneydj_code,product_name,currency,raw_payload FROM moneydj_external_products`),
  db.$queryRawUnsafe<any[]>(`SELECT fund_id,moneydj_code FROM fund_mappings WHERE moneydj_code IS NOT NULL AND moneydj_code<>'1'`)
 ]);
 const alias=new Map(aliases.map(x=>[x.fund_id,x.moneydj_code]));
 const productKeys=new Map<string,any[]>();for(const p of products){const k=norm(p.product_name);productKeys.set(k,[...(productKeys.get(k)??[]),p])}
 const secondProductKeys=new Map<string,any[]>();for(const p of products){const k=secondNorm(p.product_name);secondProductKeys.set(k,[...(secondProductKeys.get(k)??[]),p])}
 const fundKeys=new Map<string,number>();for(const f of funds)for(const k of new Set([norm(f.name),norm(f.legal_name)].filter(Boolean)))fundKeys.set(k,(fundKeys.get(k)??0)+1);
 const secondFundKeys=new Map<string,number>();for(const f of funds)for(const k of new Set([secondNorm(f.name),secondNorm(f.legal_name),secondNorm(f.name_en)].filter(Boolean)))secondFundKeys.set(k,(secondFundKeys.get(k)??0)+1);
 const results:any[]=[];
 for(const f of funds){
  if(alias.has(f.id)){results.push({fundId:f.id,status:"MAPPED",code:alias.get(f.id),method:"EXISTING_MONEYDJ_ALIAS"});continue}
  let candidates:any[]=[];let method="";
  if(f.isin){candidates=products.filter(p=>Object.values(p.raw_payload??{}).some(v=>String(v).toUpperCase()===String(f.isin).toUpperCase()));if(candidates.length)method="ISIN_EXACT"}
  if(!candidates.length){for(const k of new Set([norm(f.name),norm(f.legal_name)].filter(Boolean))){if((fundKeys.get(k)??0)!==1)continue;const hits=productKeys.get(k)??[];if(hits.length===1)candidates.push(hits[0])}candidates=[...new Map(candidates.map(x=>[x.moneydj_code,x])).values()];if(candidates.length)method="NORMALIZED_FULL_NAME_EXACT"}
  if(!candidates.length){for(const k of new Set([secondNorm(f.name),secondNorm(f.legal_name),secondNorm(f.name_en)].filter(Boolean))){if((secondFundKeys.get(k)??0)!==1)continue;const hits=secondProductKeys.get(k)??[];if(hits.length===1)candidates.push(hits[0])}candidates=[...new Map(candidates.map(x=>[x.moneydj_code,x])).values()];if(candidates.length)method="SECOND_PASS_NORMALIZED_SHARE_CLASS_EXACT"}
  if(!candidates.length){
   const provider=secondNorm(f.company),fundCores=new Set([legalNorm(f.name),legalNorm(f.legal_name),legalNorm(f.name_en)].filter(Boolean).map(k=>provider?k.replace(provider,""):k));
   candidates=products.filter(p=>{
    const productName=legalNorm(p.product_name);
    if(!provider||!productName.includes(provider)||currencyNorm(p.currency)!==currencyNorm(f.currency))return false;
    return fundCores.has(productName.replace(provider,""));
   });
   candidates=[...new Map(candidates.map(x=>[x.moneydj_code,x])).values()];if(candidates.length)method="PROVIDER_NORMALIZED_NAME_CURRENCY_EXACT";
  }
  if(candidates.length===1){const p=candidates[0];results.push({fundId:f.id,status:"MAPPED",code:p.moneydj_code,externalId:p.id,method});if(write){await db.$transaction([db.$executeRawUnsafe(`INSERT INTO fund_mappings(id,fund_id,moneydj_code,status,candidate_count,last_checked_at,created_at,updated_at) VALUES($1,$2,$3,$4,1,NOW(),NOW(),NOW()) ON CONFLICT(fund_id) DO UPDATE SET moneydj_code=EXCLUDED.moneydj_code,status=EXCLUDED.status,candidate_count=1,last_checked_at=NOW(),updated_at=NOW()`,randomUUID(),f.id,p.moneydj_code,method),db.$executeRawUnsafe(`UPDATE moneydj_external_products SET canonical_fund_id=$2,mapping_status='EXACT_FUND_MAPPED',updated_at=NOW() WHERE id=$1::uuid AND (canonical_fund_id IS NULL OR canonical_fund_id=$2)`,p.id,f.id)])}}
  else if(candidates.length>1)results.push({fundId:f.id,status:"AMBIGUOUS",candidates:candidates.length});
  else results.push({fundId:f.id,status:"UNMAPPED"});
 }
 const mapped=results.filter(x=>x.status==="MAPPED").length,additionalMapped=results.filter(x=>x.status==="MAPPED"&&x.method!=="EXISTING_MONEYDJ_ALIAS").length,ambiguous=results.filter(x=>x.status==="AMBIGUOUS").length,unmapped=results.length-mapped-ambiguous;
 console.log(JSON.stringify({target:limit,offset,tested:funds.length,mapped,additionalMapped,unmapped,ambiguous,mappingRate:funds.length?Number((mapped/funds.length*100).toFixed(2)):0,written:write?results.filter(x=>x.externalId).length:0}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
