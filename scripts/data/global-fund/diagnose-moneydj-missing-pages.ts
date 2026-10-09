import { PrismaClient } from "@prisma/client";
import { load } from "cheerio";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { deterministicMasterKey, portfolioKey } from "./services/fund-holdings-resolution.ts";

const engine=resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if(process.platform==="win32")process.env.PRISMA_QUERY_ENGINE_LIBRARY=engine;
const db=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL}}});
const excluded=/債券|bond|fixed.?income|high.?yield|investment.?grade|non.?investment.?grade|到期債|新興市場債|企業債|複合債|信用債|貨幣市場|money.?market|(?:單日)?正向(?:二|兩|2)倍|(?:二|兩|2)倍基金|\b2x\b|反向/i;
type Fund={id:string;name:string;legal_name:string|null;name_en:string|null;company:string};
type Product={moneydj_code:string;product_name:string};
const core=(v:string|null)=>portfolioKey(v).replace(/基金|funds?|portfolio|系列/g,"");

async function inspect(code:string){
 for(const page of ["yp013001","yp013000"]){
  const url=`https://www.moneydj.com/funddj/yp/${page}.djhtm?a=${encodeURIComponent(code)}&topc=`;
  const response=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 SmartFund Fund Research/1.0"},signal:AbortSignal.timeout(30000)});
  if(!response.ok)continue;
  const $=load(new TextDecoder("big5").decode(await response.arrayBuffer()));
  const month=$("body").text().match(/資料(?:月份|日期|時間)\s*[：:]\s*(\d{4})[\/.\-](\d{1,2})(?:[\/.\-](\d{1,2}))?/);
  const rows:string[]=[];
  $("table").filter((_,t)=>/投資名稱|投資標的|投資明細/.test($(t).text())&&/比例|比重|%/.test($(t).text())).find("tr").each((_,tr)=>{
   const cells=$(tr).find("td").map((__,td)=>$(td).text().replace(/\s+/g," ").trim()).get();
   for(const start of [0,3,4]){const name=cells[start],weight=[cells[start+2],cells[start+1]].find(v=>/%/.test(v??""));if(name&&weight&&!/投資名稱|投資標的|投資明細/.test(name))rows.push(name)}
  });
  if(month&&new Set(rows).size)return{code,url,month:`${month[1]}-${month[2].padStart(2,"0")}`,count:new Set(rows).size};
 }
 return null;
}

async function main(){
 const [funds,held,products]=await Promise.all([
  db.$queryRawUnsafe<Fund[]>(`SELECT id,name,legal_name,name_en,company FROM funds WHERE is_active=true ORDER BY id`),
  db.$queryRawUnsafe<Array<{fund_id:string}>>(`SELECT DISTINCT fund_id FROM holdings WHERE fund_id IS NOT NULL AND share_class_id IS NULL`),
  db.$queryRawUnsafe<Product[]>(`SELECT moneydj_code,product_name FROM moneydj_external_products WHERE moneydj_code IS NOT NULL AND moneydj_code<>'1'`),
 ]);
 const byId=new Map(funds.map(f=>[f.id,f])),groups=new Map<string,Fund[]>();for(const f of funds){const k=deterministicMasterKey(f);groups.set(k,[...(groups.get(k)??[]),f])}
 const heldKeys=new Set(held.flatMap(x=>byId.has(x.fund_id)?[deterministicMasterKey(byId.get(x.fund_id)!)]:[]));
 const productByCore=new Map<string,Product[]>();for(const p of products){const k=core(p.product_name);if(k)productByCore.set(k,[...(productByCore.get(k)??[]),p])}
 const targets=[...groups].filter(([k,m])=>!heldKeys.has(k)&&!m.some(f=>excluded.test(f.name)));
 const exportRows=targets.map(([,members])=>{const keys=new Set(members.flatMap(f=>[core(f.name),core(f.legal_name),core(f.name_en)]).filter(Boolean));const candidates=[...new Map([...keys].flatMap(k=>productByCore.get(k)??[]).map(p=>[p.moneydj_code,p])).values()];return{master:members[0].name,queries:[...new Set(members.flatMap(f=>[f.legal_name,f.name_en,f.name]).filter(Boolean))].slice(0,6),candidates:candidates.slice(0,8)}});
 writeFileSync(resolve("runtime/global-fund/moneydj-browser-targets.json"),JSON.stringify(exportRows));
 if(process.argv.includes("--export-only")){console.log(JSON.stringify({exported:exportRows.length}));return}
 const recovered:Array<Record<string,unknown>>=[],unresolved:string[]=[];let attemptedPages=0;
 async function one([,members]:[string,Fund[]]){const keys=new Set(members.flatMap(f=>[core(f.name),core(f.legal_name),core(f.name_en)]).filter(Boolean));const candidates=[...new Map([...keys].flatMap(k=>productByCore.get(k)??[]).map(p=>[p.moneydj_code,p])).values()];for(const p of candidates.slice(0,5)){attemptedPages++;const hit=await inspect(p.moneydj_code);if(hit){recovered.push({master:members[0].name,product:p.product_name,...hit});return}}unresolved.push(members[0].name)}
 for(let i=0;i<targets.length;i+=6)await Promise.all(targets.slice(i,i+6).map(one));
 console.log(JSON.stringify({target:targets.length,attemptedPages,recovered:recovered.length,unresolved:unresolved.length,recoveredFunds:recovered,unresolvedFunds:unresolved}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
