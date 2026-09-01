import type { PrismaClient } from "@prisma/client";

const clean=(v:string|null|undefined)=>(v??"").normalize("NFKC").toLowerCase().replace(/\([^)]*(?:本基金|配息來源|未申報|已撤銷)[^)]*\)/g,"").replace(/（[^）]*(?:本基金|配息來源|未申報|已撤銷)[^）]*）/g,"").replace(/臺/g,"台");
const providerKey=(v:string|null|undefined)=>clean(v).replace(/股份有限公司|有限公司|投資信託股份|證券投資信託|投資信託|投信|資產管理|assetmanagement|investmentmanagement|investments?/g,"").replace(/[\s\-_,.()（）/／:]/g,"");
const portfolioKey=(v:string|null|undefined)=>clean(v).replace(/(?:class\s*)?[a-z]{1,4}\d{0,3}(?=(?:累積|配息|月配|分配|美元|美金|歐元|澳幣|南非幣|日圓|人民幣|台幣|新台幣|避險|不避險))/gi,"").replace(/(?:class\s*[a-z0-9-]+|[a-z]{1,4}\d{0,3}\s*(?:class|shares?|類|級|股|股份))/gi,"").replace(/\b(?:usd|eur|aud|zar|twd|jpy|cnh|cny)\b|新?台幣|美元|美金|歐元|澳幣|南非幣|日圓|離岸?人民幣/g,"").replace(/未避險|不避險|非避險|unhedged|避險|對沖|hedged/g,"").replace(/每月配息|每月分配|穩定月配息|月配息?|配息型?|分配型?|distribution|distributing|dist\b|累積型?|不配息|不分配|accumulating|acc\b/g,"").replace(/[\s\-_,.()（）/／:。，]/g,"");
const masterKey=(f:{company:string;name:string;legal_name:string|null;name_en:string|null})=>`${providerKey(f.company)}|${portfolioKey(f.legal_name||f.name_en||f.name)}`;

async function snapshot(db:PrismaClient,fundId:string){
 const [selected]=await db.$queryRawUnsafe<Array<{source:string;filing_id:string;as_of_date:Date;retrieved_at:Date}>>(`SELECT source,filing_id,as_of_date,max(created_at) retrieved_at FROM holdings WHERE fund_id=$1 AND share_class_id IS NULL GROUP BY source,filing_id,as_of_date ORDER BY as_of_date DESC,count(*) DESC LIMIT 1`,fundId);
 if(!selected)return null;
 const holdings=await db.$queryRawUnsafe<Array<Record<string,unknown>>>(`SELECT h.*,s.name security_name,s.ticker security_ticker,s.country security_country FROM holdings h LEFT JOIN securities s ON s.id=h.security_id WHERE h.fund_id=$1 AND h.share_class_id IS NULL AND h.source=$2 AND h.filing_id=$3 ORDER BY h.rank,h.id`,fundId,selected.source,selected.filing_id);
 return{...selected,holdings};
}

export async function resolveFundHoldings(db:PrismaClient,fundId:string){
 const direct=await snapshot(db,fundId);if(direct)return{masterFundId:fundId,resolutionStatus:"DIRECT",...direct};
 const funds=await db.$queryRawUnsafe<Array<{id:string;company:string;name:string;legal_name:string|null;name_en:string|null}>>(`SELECT id,company,name,legal_name,name_en FROM funds WHERE is_active=true`),requested=funds.find(f=>f.id===fundId);if(!requested)return null;
 const peers=funds.filter(f=>f.id!==fundId&&masterKey(f)===masterKey(requested)).map(f=>f.id);if(!peers.length)return null;
 const [master]=await db.$queryRawUnsafe<Array<{fund_id:string}>>(`SELECT fund_id FROM holdings WHERE fund_id=ANY($1::text[]) AND share_class_id IS NULL GROUP BY fund_id,source,filing_id,as_of_date ORDER BY as_of_date DESC,count(*) DESC,fund_id LIMIT 1`,peers);if(!master)return null;
 const inherited=await snapshot(db,master.fund_id);return inherited?{masterFundId:master.fund_id,resolutionStatus:"INHERITED_FROM_MASTER",...inherited}:null;
}
