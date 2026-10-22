import { createHash } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { load } from "cheerio";

type Issuer = "YUANTA" | "FUBON" | "CATHAY" | "CAPITAL";
type Outcome = "SUCCESS" | "PARTIAL" | "ACCESS_BLOCKED" | "SOURCE_CHANGED" | "PARSE_FAILED" | "NO_PUBLIC_HOLDINGS" | "UNSUPPORTED_STRUCTURE";
type Etf = { id: string; code: string; name: string; provider: string; asset_id: string | null };
type Holding = { symbol: string | null; name: string; weight: number | null; quantity?: number | null; marketValue?: number | null; holdingType: string };
type Parsed = { asOfDate: string; sourceUrl: string; sourceType: string; body: Buffer; rows: Holding[]; partial?: boolean };

const engine = path.resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if (process.platform === "win32" && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine;
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const onlyIssuer = process.argv.find(x => x.startsWith("--issuer="))?.split("=")[1]?.toUpperCase() as Issuer | undefined;
const dryRun = process.argv.includes("--dry-run");
const limit = Number(process.argv.find(x => x.startsWith("--limit="))?.split("=")[1] ?? "0");
const remainingBatch = process.argv.includes("--remaining");
const timeout = 30_000;

const issuerFor = (provider: string, name=""): Issuer | null => (provider+name).includes("元大") ? "YUANTA" : (provider+name).includes("富邦") ? "FUBON" : (provider+name).includes("國泰") ? "CATHAY" : (provider+name).includes("群益") ? "CAPITAL" : null;
const number = (value: string | undefined | null) => { const clean = (value ?? "").replace(/[,%\s]/g, ""); return clean && Number.isFinite(Number(clean)) ? Number(clean) : null; };
const text = (value: string) => value.replace(/\s+/g, " ").trim();
const date = (value: string) => { const m = value.match(/(20\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}` : null; };
const taipeiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Taipei", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
const latestNonFutureDate = (value: string) => [...value.matchAll(/20\d{2}[\/.\-]\d{1,2}[\/.\-]\d{1,2}/g)].map(x=>date(x[0])).filter((x):x is string=>!!x&&x<=taipeiToday()).sort().at(-1)??null;
const uuid = (value: string) => { const h=createHash("sha256").update(value).digest("hex").slice(0,32).split(""); h[12]="5"; h[16]=((parseInt(h[16],16)&3)|8).toString(16); return `${h.slice(0,8).join("")}-${h.slice(8,12).join("")}-${h.slice(12,16).join("")}-${h.slice(16,20).join("")}-${h.slice(20).join("")}`; };
const checksum = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const safe = (value: string) => value.replace(/[^0-9A-Za-z._-]+/g,"-").slice(0,100);
const typeFrom = (heading: string, symbol: string | null, name: string) => /期貨|FUTURE/i.test(heading+name) ? "FUTURE" : /債|BOND/i.test(heading) ? "BOND" : /現金|CASH/i.test(heading+name) ? "CASH" : /股票|STOCK|EQUITY/i.test(heading) || !!symbol ? "EQUITY" : "OTHER";

async function get(url: string) {
  const response = await fetch(url, { redirect:"follow", signal:AbortSignal.timeout(timeout), headers:{"user-agent":"SmartFund-Taiwan-ETF-Holdings/1.0","accept":"text/html,application/json;q=0.9,*/*;q=0.1"} });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function parseDivTables(html: string) {
  const $ = load(html), rows: Holding[] = [];
  $(".each_table, [class*='pct-'][class*='table']").each((_, table) => {
    const heading = text($(table).prevAll("h3,h4,.title,.table-title").first().text()) || text($(table).parent().find("h3,h4").first().text());
    const headers=$(table).find(".thead .tr").first().children(".td,.th").map((__,cell)=>text($(cell).text())).get();
    const weightIndex=headers.findIndex(value=>/權重/.test(value));
    const quantityIndex=headers.findIndex(value=>/數量|股數|口數/.test(value));
    $(table).find(".tbody .tr").each((__, tr) => {
      let cells = $(tr).children(".td,.th").map((___, cell) => {
        const spans=$(cell).children("span"); return text(spans.length>1 ? spans.last().text() : $(cell).text());
      }).get();
      if (cells.length < 3) return;
      const symbol = cells[0] && !/合計|總計/.test(cells[0]) ? cells[0] : null;
      const name = cells[1];
      const percentIndex = cells.findIndex((x,i)=>i>=2 && /%$/.test(x));
      const weight = number(weightIndex >= 0 ? cells[weightIndex] : percentIndex >= 0 ? cells[percentIndex] : cells.at(-1));
      if (!name || weight == null || /合計|總計/.test(name)) return;
      rows.push({symbol,name,weight,quantity:number(quantityIndex>=0?cells[quantityIndex]:null),holdingType:typeFrom(heading,symbol,name)});
    });
  });
  $(".futures-table .tbody .tr").each((_,tr)=>{
    const name=text($(tr).find(".th-name .td-mobile").first().text())||text($(tr).prev("h4").text());
    const values=$(tr).find(".td .td-mobile").map((__,x)=>text($(x).text())).get();
    const weight=number(values[0]), quantity=number(values[1]);
    if(name&&weight!=null)rows.push({symbol:name.match(/^[A-Za-z]+/)?.[0]??null,name,weight,quantity,holdingType:"FUTURE"});
  });
  return [...new Map(rows.map(row=>[`${row.holdingType}|${row.symbol??""}|${row.name}`,row])).values()];
}

async function yuanta(etf: Etf): Promise<Parsed> {
  const sourceUrl=`https://www.yuantaetfs.com/product/detail/${encodeURIComponent(etf.code)}/ratio`, body=await get(sourceUrl), html=body.toString("utf8"), $=load(html);
  const asOfDate=date($("body").text().match(/交易日期\s*:?\s*20\d{2}[\/.]\d{1,2}[\/.]\d{1,2}/)?.[0] ?? "");
  const rows=parseDivTables(html);
  if (!asOfDate || !rows.length) throw new Error("YUANTA_SOURCE_CHANGED");
  return {asOfDate,sourceUrl,sourceType:"OFFICIAL_ISSUER_HTML",body,rows,partial:true};
}

async function fubon(etf: Etf): Promise<Parsed> {
  const sourceUrl=`https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=${encodeURIComponent(etf.code)}`, body=await get(sourceUrl), html=body.toString("utf8"), $=load(html);
  const asOfDate=date($("body").text().match(/資料日期\s*[:：]\s*20\d{2}[\/.]\d{1,2}[\/.]\d{1,2}/)?.[0] ?? ""), rows:Holding[]=[];
  $("table").each((_,table)=>{const head=text($(table).find("tr").first().text());const headers=$(table).find("tr").first().find("th,td").map((__,x)=>text($(x).text())).get();const wi=headers.findIndex(x=>/權重/.test(x));if(wi<0)return;$(table).find("tr").slice(1).each((__,tr)=>{const cells=$(tr).find("th,td").map((___,x)=>text($(x).text())).get();const symbol=cells[0],name=cells[1],weight=number(cells[wi]);if(!symbol||!name||weight==null||/合計|總計/.test(symbol+name))return;rows.push({symbol,name,weight,quantity:number(cells[2]),marketValue:number(cells[3]),holdingType:typeFrom(head,symbol,name)})})});
  if (!asOfDate || !rows.length) throw new Error("FUBON_SOURCE_CHANGED");
  return {asOfDate,sourceUrl,sourceType:"OFFICIAL_ISSUER_HTML",body,rows};
}

let cathayMap: Map<string,string> | null = null;
async function cathayCodes() {
  if (cathayMap) return cathayMap;
  cathayMap=new Map();
  for(let page=1;page<=10;page++){const body=await get(`https://cwapi.cathaysite.com.tw/api/ETF/GetETFList?CurrentPage=${page}`);const value=JSON.parse(body.toString("utf8"));for(const row of value.result??[])if(row.stockCode&&row.fundCode)cathayMap.set(row.stockCode,row.fundCode);if(page>=(value.totalPage??0))break;}
  return cathayMap;
}

async function cathay(etf: Etf): Promise<Parsed> {
  const codes=await cathayCodes(), fundCode=codes.get(etf.code)??(etf.code.endsWith("K")?codes.get(etf.code.slice(0,-1)):undefined); if(!fundCode)throw new Error("CATHAY_PRODUCT_NOT_LISTED");
  const root="https://cwapi.cathaysite.com.tw/api/ETF/", assetsBody=await get(`${root}GetETFAssets?FundCode=${encodeURIComponent(fundCode)}`), assets=JSON.parse(assetsBody.toString("utf8"));
  const asOfDate=date(assets.result?.preDate??""); if(!asOfDate)throw new Error("CATHAY_SOURCE_CHANGED");
  const endpoints=["GetETFDetailStockList","GetETFDetailBondList","GetETFDetailFutureList","GetETFDetailETFList","GetETFDetailFundList","GetETFDetailBuyList"];
  const responses=await Promise.all(endpoints.map(async endpoint=>{const url=`${root}${endpoint}?FundCode=${encodeURIComponent(fundCode)}&SearchDate=${asOfDate}`;const body=await get(url);return {endpoint,body,value:JSON.parse(body.toString("utf8"))}}));
  const rows:Holding[]=[];
  for(const response of responses) for(const x of Array.isArray(response.value.result)?response.value.result:[]){
    const symbol=x.stockCode??x.bondNo??x.ftNo??x.etfCode??x.fundCode??x.code??null;
    const name=x.stockName??x.bondName??x.ftName??x.etfName??x.fundName??x.name;
    const weight=number(String(x.weights??x.ntMkval??x.weight??x.ratio??""));
    const quantity=number(String(x.volumn??x.parValue??x.quantity??x.shares??""));
    if(name&&weight!=null)rows.push({symbol,name,weight,quantity,marketValue:number(String(x.mkval??x.marketValue??"")),holdingType:typeFrom(response.endpoint,symbol,name)});
  }
  const body=Buffer.concat([assetsBody,...responses.map(x=>x.body)]);
  if (!asOfDate || !rows.length) throw new Error("CATHAY_SOURCE_CHANGED");
  return {asOfDate,sourceUrl:`https://www.cathaysite.com.tw/ETF/detail/E${encodeURIComponent(fundCode)}?tab=etf3`,sourceType:"OFFICIAL_ISSUER_API",body,rows};
}

let capitalMap: Map<string,string> | null = null;
async function capitalCodes() {
  if(capitalMap)return capitalMap; capitalMap=new Map([
    ["00643","069"],["00643K","069"],["00678","103"],["00685L","094"],["00686R","095"],["00714","166"],
    ["00919","195"],["00923","365"],["00927","366"],["00946","388"],["00953B","389"],["00982A","399"],
    ["00985B","390"],["00992A","500"],["00997A","502"],["009824","503"]
  ]);
  const sitemap=(await get("https://www.capitalfund.com.tw/sitemap.xml")).toString("utf8");
  const ids=[...new Set([...sitemap.matchAll(/\/etf\/product\/detail\/(\d+)\/basic/g)].map(x=>x[1]))];
  for(let i=0;i<ids.length;i+=2) {
    await Promise.all(ids.slice(i,i+2).map(async id=>{
      for(let attempt=0;attempt<3;attempt++) try {
        const html=(await get(`https://www.capitalfund.com.tw/etf/product/detail/${id}/basic`)).toString("utf8");
        const code=html.match(/(?:證券代碼|股票代號|基金代碼)[^0-9A-Z]{0,80}([0-9]{5,6}[A-Z]?)/)?.[1]??html.match(/\b(00\d{3,4}[A-Z]?)\b/)?.[1];
        if(code)capitalMap!.set(code,id);
        break;
      } catch { if(attempt<2) await new Promise(resolve=>setTimeout(resolve,500*(attempt+1))); }
    }));
  }
  return capitalMap;
}

async function capital(etf: Etf): Promise<Parsed> {
  const id=(await capitalCodes()).get(etf.code); if(!id)throw new Error("CAPITAL_PRODUCT_NOT_LISTED");
  const sourceUrl=`https://www.capitalfund.com.tw/etf/product/detail/${id}/buyback`, body=await get(sourceUrl), html=body.toString("utf8"), $=load(html);
  const asOfDate=latestNonFutureDate($("body").text());
  const rows=parseDivTables(html);
  if(!asOfDate||!rows.length)throw new Error("CAPITAL_SOURCE_CHANGED");
  return {asOfDate,sourceUrl,sourceType:"OFFICIAL_ISSUER_HTML",body,rows,partial:true};
}

async function write(etf:Etf,issuer:Issuer,parsed:Parsed){
  if(parsed.asOfDate>taipeiToday())throw new Error(`FUTURE_ASOF_DATE:${parsed.asOfDate}`);
  const hash=checksum(parsed.body),snapshotId=uuid(`${etf.id}|${parsed.asOfDate}|${parsed.sourceUrl}|${hash}`),retrievedAt=new Date().toISOString();
  const canonical=parsed.rows.map((r,i)=>({id:uuid(`${snapshotId}|${i+1}|${r.symbol??r.name}`),snapshot_id:snapshotId,etf_id:etf.id,effective_date:parsed.asOfDate,holding_type:r.holdingType,holding_name:r.name,ticker:r.symbol,quantity:r.quantity??null,market_value:r.marketValue??null,weight:r.weight,source_row_id:`${etf.code}:${parsed.asOfDate}:${i+1}:${safe(r.symbol??r.name)}`,verification_status:"VERIFIED_OFFICIAL",quality_status:r.weight==null?"PARTIAL":"PASS",raw_row:r}));
  if(dryRun)return {snapshotId,rows:canonical.length,write:"DRY_RUN"};
  await prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe(`INSERT INTO etf_holding_snapshots(id,etf_id,effective_date,report_date,source,source_type,source_url,retrieved_at,checksum,source_row_count,parsed_row_count,canonical_row_count,verification_status,license_status,completeness_status,quality_status,quality_metrics,parser_version,archive_lineage) VALUES($1::uuid,$2,$3::date,$3::date,$4,$5,$6,$7::timestamptz,$8,$9,$9,$9,'VERIFIED_OFFICIAL','PUBLIC_OFFICIAL_REVIEW_REQUIRED',$10,$11,$12::jsonb,'1.0.0',$13::jsonb) ON CONFLICT(etf_id,effective_date,source_url,checksum) DO NOTHING`,snapshotId,etf.id,parsed.asOfDate,`${issuer}_OFFICIAL`,parsed.sourceType,parsed.sourceUrl,retrievedAt,hash,canonical.length,parsed.partial?"PARTIAL_SOURCE_SNAPSHOT":"FULL_SOURCE_SNAPSHOT",parsed.partial?"QUALITY_WARNING":"PASS",JSON.stringify({knownWeightSum:parsed.rows.reduce((s,r)=>s+(r.weight??0),0)}),JSON.stringify({sourceUrl:parsed.sourceUrl,checksum:hash,retrievedAt}));
    await tx.$executeRawUnsafe(`INSERT INTO etf_holdings(id,snapshot_id,etf_id,effective_date,holding_type,holding_name,ticker,quantity,market_value,weight,source_row_id,verification_status,quality_status,raw_row) SELECT x.id::uuid,x.snapshot_id::uuid,x.etf_id,x.effective_date::date,x.holding_type,x.holding_name,x.ticker,x.quantity,x.market_value,x.weight,x.source_row_id,x.verification_status,x.quality_status,x.raw_row FROM jsonb_to_recordset($1::jsonb)x(id text,snapshot_id text,etf_id text,effective_date text,holding_type text,holding_name text,ticker text,quantity numeric,market_value numeric,weight numeric,source_row_id text,verification_status text,quality_status text,raw_row jsonb) ON CONFLICT(snapshot_id,source_row_id) DO NOTHING`,JSON.stringify(canonical));
    await tx.$executeRawUnsafe(`INSERT INTO holdings(id,asset_type,etf_id,as_of_date,rank,holding_name,holding_code,ticker,weight,asset_id,shares,market_value,currency,source,source_record_id,weight_method,created_at) SELECT x.id,'ETF',$1,$2::date,x.rank,x.holding_name,x.ticker,x.ticker,x.weight,$3,x.quantity,x.market_value,'TWD',$4,x.source_row_id,'ISSUER_REPORTED',NOW() FROM jsonb_to_recordset($5::jsonb)x(id text,rank int,holding_name text,ticker text,weight numeric,quantity numeric,market_value numeric,source_row_id text) WHERE NOT EXISTS(SELECT 1 FROM holdings h WHERE h.etf_id=$1 AND h.as_of_date=$2::date AND h.asset_type='ETF') ON CONFLICT DO NOTHING`,etf.id,parsed.asOfDate,etf.asset_id,`${issuer}_OFFICIAL`,JSON.stringify(canonical.map((x,i)=>({id:uuid(`legacy|${x.id}`),rank:i+1,holding_name:x.holding_name,ticker:x.ticker,weight:x.weight,quantity:x.quantity,market_value:x.market_value,source_row_id:x.source_row_id}))));
  },{maxWait:10_000,timeout:60_000});
  const count=await prisma.etfHoldingRow.count({where:{snapshotId}});if(count!==canonical.length)throw new Error(`READBACK_MISMATCH:${count}/${canonical.length}`);
  return {snapshotId,rows:count,write:"PASS"};
}

function outcome(error:unknown):Outcome{const m=String(error);if(/HTTP_401|HTTP_403|HTTP_429|timeout|fetch failed/i.test(m))return "ACCESS_BLOCKED";if(/SOURCE_CHANGED|PRODUCT_NOT_LISTED/.test(m))return "SOURCE_CHANGED";if(/NO_PUBLIC/.test(m))return "NO_PUBLIC_HOLDINGS";return "PARSE_FAILED";}

async function main(){
  let etfs=remainingBatch
    ? await prisma.$queryRawUnsafe<Etf[]>(`SELECT id,code,name,provider,asset_id FROM etfs WHERE is_active=true AND (exchange IN ('TWSE','TPEx') OR (exchange IS NULL AND currency='TWD')) AND NOT (provider LIKE '%元大%' OR provider LIKE '%富邦%' OR provider LIKE '%國泰%' OR provider LIKE '%群益%') ORDER BY provider,code`)
    : await prisma.$queryRawUnsafe<Etf[]>(`SELECT id,code,name,provider,asset_id FROM etfs WHERE is_active=true AND (provider LIKE '%元大%' OR provider LIKE '%富邦%' OR provider LIKE '%國泰%' OR provider LIKE '%群益%') ORDER BY CASE WHEN provider LIKE '%元大%' THEN 1 WHEN provider LIKE '%富邦%' THEN 2 WHEN provider LIKE '%國泰%' THEN 3 ELSE 4 END,code`);
  if(onlyIssuer)etfs=etfs.filter(e=>issuerFor(e.provider,e.name)===onlyIssuer);if(limit>0)etfs=etfs.slice(0,limit);
  const results:any[]=[];
  for(const etf of etfs){const issuer=issuerFor(etf.provider,etf.name);if(!issuer){results.push({issuer:etf.provider,code:etf.code,status:"UNSUPPORTED_STRUCTURE",error:"NO_EXISTING_OFFICIAL_ISSUER_ADAPTER"});console.log(JSON.stringify(results.at(-1)));continue;}try{const parsed=issuer==="YUANTA"?await yuanta(etf):issuer==="FUBON"?await fubon(etf):issuer==="CATHAY"?await cathay(etf):await capital(etf);const written=await write(etf,issuer,parsed);results.push({issuer,code:etf.code,status:parsed.partial?"PARTIAL":"SUCCESS",asOfDate:parsed.asOfDate,holdingRows:parsed.rows.length,weightCoverage:parsed.rows.reduce((s,r)=>s+(r.weight??0),0),...written});}catch(error){results.push({issuer,code:etf.code,status:outcome(error),error:String(error)});}console.log(JSON.stringify(results.at(-1)));}
  const summary=Object.fromEntries((["YUANTA","FUBON","CATHAY","CAPITAL"] as Issuer[]).map(i=>{const r=results.filter(x=>x.issuer===i);return[i,{total:r.length,success:r.filter(x=>x.status==="SUCCESS"||x.status==="PARTIAL").length,failed:r.filter(x=>x.status!=="SUCCESS"&&x.status!=="PARTIAL").length,statuses:Object.fromEntries([...new Set(r.map(x=>x.status))].map(s=>[s,r.filter(x=>x.status===s).length]))}]}));
  const statuses=Object.fromEntries([...new Set(results.map(x=>x.status))].map(s=>[s,results.filter(x=>x.status===s).length]));
  const failedBreakdown=Object.fromEntries([...new Set(results.filter(x=>x.status!=="SUCCESS"&&x.status!=="PARTIAL").map(x=>x.status))].map(s=>[s,results.filter(x=>x.status===s).map(x=>x.code)]));
  const issuerCoverage=Object.fromEntries([...new Set(results.map(x=>x.issuer))].map(i=>{const r=results.filter(x=>x.issuer===i);return[i,{total:r.length,complete:r.filter(x=>x.status==="SUCCESS").length,partial:r.filter(x=>x.status==="PARTIAL").length,failed:r.filter(x=>x.status!=="SUCCESS"&&x.status!=="PARTIAL").length}]}));
  console.log("FINAL_SUMMARY="+JSON.stringify({dryRun,total:results.length,statuses,summary,issuerCoverage,failedBreakdown}));
}

main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>prisma.$disconnect());
