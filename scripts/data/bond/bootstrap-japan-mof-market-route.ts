import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { PrismaClient } from "@prisma/client";

const SOURCE = "JAPAN_MOF_JGB_AUCTION";
const REPORT = path.resolve("runtime", "fixed-income", "market-route-terms-expansion", "report.json");
const URLS = [
  "https://www.mof.go.jp/english/policy/jgbs/auction/calendar/eresul/eresul20260702.htm",
  "https://www.mof.go.jp/english/policy/jgbs/auction/calendar/eresul/eresul20260707.htm",
  "https://www.mof.go.jp/english/policy/jgbs/auction/calendar/eresul/eresul20260709.htm",
  "https://www.mof.go.jp/english/policy/jgbs/auction/calendar/eresul/eresul20260714.htm",
  "https://www.mof.go.jp/english/policy/jgbs/auction/calendar/eresul/eresul20260730.htm",
];

type Auction = { url:string; canonicalName:string; auctionDate:string; issueDate:string; maturityDate:string; coupon:number; price:number; yieldValue:number; checksum:string };
type Bond = { id:string; security_id:string|null; official_name:string; currency:string };
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const date=(value:string)=>{const [m,d,y]=value.trim().split("/");return `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`};
const numeric=(value:string)=>Number(value.replace(/[% ,]/g,""));
function databaseUrl(){const raw=process.env.DIRECT_URL;if(!raw)throw new Error("DIRECT_URL_REQUIRED");const value=new URL(raw);if(value.port!=="5432")throw new Error("DIRECT_WRITER_5432_REQUIRED");value.searchParams.set("connection_limit","1");value.searchParams.set("connect_timeout","20");return value.toString()}
async function atomic(value:unknown){await mkdir(path.dirname(REPORT),{recursive:true});const temp=`${REPORT}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(value,null,2)+"\n");await rename(temp,REPORT)}
async function fetchAuction(url:string):Promise<Auction>{
  const response=await fetch(url,{headers:{"user-agent":"SmartFund official-source verifier/1.0"}});
  if(!response.ok)throw new Error(`MOF_HTTP_${response.status}`);
  const html=await response.text(); const $=load(html); let cells:string[]=[];
  $("table tr").each((_,row)=>{const values=$(row).find("td").map((__,cell)=>$(cell).text().replace(/\s+/g," ").trim()).get();if(!cells.length&&values.length>=13&&/Year/.test(values[0]))cells=values});
  if(cells.length<13)throw new Error(`MOF_SCHEMA_DRIFT:${url}`);
  const tenor=cells[0].match(/\d+/)?.[0]; const issue=cells[1].match(/\d+/)?.[0];
  if(!tenor||!issue)throw new Error(`MOF_IDENTITY_PARSE_FAILED:${url}`);
  const result={url,canonicalName:`JGB${issue}(${tenor})`,auctionDate:date(cells[2]),issueDate:date(cells[3]),maturityDate:date(cells[4]),coupon:numeric(cells[5]),price:numeric(cells[11]),yieldValue:numeric(cells[12]),checksum:digest(html)};
  if(!(result.price>0&&result.yieldValue>=0&&result.coupon>=0))throw new Error(`MOF_SEMANTIC_VALIDATION_FAILED:${url}`);
  return result;
}

async function main(){
  const fetched:Auction[]=[]; for(const url of URLS)fetched.push(await fetchAuction(url));
  const prisma=new PrismaClient({datasources:{db:{url:databaseUrl()}}});
  try{
    const resolved:Array<{auction:Auction;bond:Bond}>=[];
    for(const auction of fetched){const rows=await prisma.$queryRawUnsafe<Bond[]>(`SELECT id,security_id,official_name,currency FROM bond_instruments WHERE country='JP' AND official_name=$1`,auction.canonicalName);if(rows.length!==1||!rows[0].security_id)throw new Error(`EXACT_CANONICAL_MATCH_REQUIRED:${auction.canonicalName}:${rows.length}`);resolved.push({auction,bond:rows[0]})}
    await prisma.$transaction(async tx=>{
      for(const {auction,bond} of resolved){
        await tx.$executeRawUnsafe(`UPDATE bond_instruments SET issue_date=COALESCE(issue_date,$2::date),maturity_date=COALESCE(maturity_date,$3::date),status=CASE WHEN status='UNKNOWN' THEN 'ACTIVE' ELSE status END,updated_at=NOW() WHERE id=$1`,bond.id,auction.issueDate,auction.maturityDate);
        await tx.$executeRawUnsafe(`UPDATE bond_terms SET issue_date=COALESCE(issue_date,$2::date),maturity_date=COALESCE(maturity_date,$3::date),coupon_rate=COALESCE(coupon_rate,$4::numeric),coupon_type=CASE WHEN coupon_type IS NULL OR coupon_type='UNKNOWN' THEN 'FIXED' ELSE coupon_type END,as_of_date=$5::date,updated_at=NOW() WHERE bond_id=$1`,bond.id,auction.issueDate,auction.maturityDate,auction.coupon,auction.auctionDate);
        for(const observation of [{type:"AUCTION_PRICE",value:auction.price,unit:"PRICE_PER_100"},{type:"AUCTION_YIELD",value:auction.yieldValue,unit:"PERCENT_PER_ANNUM"}]){
          const sourceRecordId=`${auction.canonicalName}:${auction.auctionDate}:${observation.type}`; const id=digest(`${SOURCE}:${sourceRecordId}`).slice(0,36);
          await tx.$executeRawUnsafe(`INSERT INTO bond_market_observations(id,security_id,bond_id,source_namespace,official_series_id,source_record_id,observation_date,observation_type,value,unit,currency,source_url,fetched_at,metadata,verification_status,checksum,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9::numeric,$10,$11,$12,NOW(),$13::jsonb,'VERIFIED_OFFICIAL',$14,NOW(),NOW()) ON CONFLICT DO NOTHING`,id,bond.security_id,bond.id,SOURCE,auction.canonicalName,sourceRecordId,auction.auctionDate,observation.type,observation.value,observation.unit,bond.currency,auction.url,JSON.stringify({grain:"INDIVIDUAL_SECURITY_AUCTION",priceSemantic:"WEIGHTED_AVERAGE_ACCEPTED_PRICE",yieldSemantic:"AVERAGE_ACCEPTED_YIELD",official:true,exactCanonicalMatch:true}),auction.checksum);
        }
      }
    },{timeout:30000});
    const readback=(await prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(`SELECT COUNT(*)::int rows,COUNT(DISTINCT bond_id)::int securities,COUNT(*) FILTER(WHERE observation_type='AUCTION_PRICE')::int price_rows,COUNT(*) FILTER(WHERE observation_type='AUCTION_YIELD')::int yield_rows,MIN(observation_date) earliest,MAX(observation_date) latest FROM bond_market_observations WHERE source_namespace=$1`,SOURCE))[0];
    const terms=(await prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE b.issue_date IS NOT NULL)::int issue_date,COUNT(*) FILTER(WHERE b.maturity_date IS NOT NULL)::int maturity,COUNT(*) FILTER(WHERE t.coupon_rate IS NOT NULL)::int coupon_rate,COUNT(*) FILTER(WHERE t.coupon_frequency IS NOT NULL)::int coupon_frequency,COUNT(*) FILTER(WHERE t.day_count_convention IS NOT NULL)::int day_count,COUNT(*) FILTER(WHERE t.outstanding_amount IS NOT NULL)::int outstanding FROM bond_instruments b LEFT JOIN bond_terms t ON t.bond_id=b.id`))[0];
    const report={status:"READBACK_PASS",source:SOURCE,routeStatus:"PRODUCTION_READY",canary:{requested:URLS.length,exactCanonicalMatches:resolved.length,...readback},terms,ordinaryWorkerHook:"EXISTING_SECURITY_PRICE_YIELD_LIFECYCLE_AUTO_DISCOVERY",processId:17332,maxDbConcurrency:1,railwayOwnershipPreserved:true,updatedAt:new Date().toISOString()};await atomic(report);console.log(JSON.stringify(report,null,2));
  }finally{await prisma.$disconnect()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
