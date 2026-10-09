import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, any>;
const p = new PrismaClient();
const sourceUrl = "https://www.jpx.co.jp/english/listing/stocks/new/index.html";
const now = () => new Date().toISOString();
const uuid = (s:string) => { const h=createHash("sha256").update(s).digest("hex").slice(0,32).split("");h[12]="4";h[16]="8";return `${h.slice(0,8).join("")}-${h.slice(8,12).join("")}-${h.slice(12,16).join("")}-${h.slice(16,20).join("")}-${h.slice(20).join("")}`; };
const num=(s:string)=>{const n=Number(s.replaceAll(",","").match(/[\d.]+/)?.[0]);return Number.isFinite(n)?n:null;};

async function main(){
  const response=await fetch(sourceUrl,{headers:{"User-Agent":"SmartFund IPO data operator admin@smartfund.local"},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`JPX_HTTP_${response.status}`);
  const $=cheerio.load(await response.text()), trs=$("table tr").toArray();
  const parsed:Row[]=[];
  for(let i=0;i<trs.length-1&&parsed.length<5;i++){
    const a=$(trs[i]).find("td").map((_,x)=>$(x).text().replace(/\s+/g," ").trim()).get();
    const b=$(trs[i+1]).find("td").map((_,x)=>$(x).text().replace(/\s+/g," ").trim()).get();
    const date=a[0]?.match(/\b(\w{3}\.\s+\d{1,2},\s+\d{4})/)?.[1], ticker=a[2]?.match(/\b\d{3,4}[A-Z]?\b/)?.[0];
    if(!date||!ticker||b.length<4)continue;
    const listingDate=new Date(date).toISOString().slice(0,10), price=num(b[3]??"");
    const primary=(num(a[6]??"")??0)*1000, secondary=(num((b[4]??"").split("(OA")[0])??0)*1000;
    parsed.push({ticker,listingDate,price,primary:primary||null,secondary:secondary||null,total:(primary+secondary)||null,gross:price&&primary?price*primary:null,recordId:`${ticker}:${listingDate}`});i++;
  }
  let verifiedLinks=0, firstDay=0, return30=0, return90=0;
  for(const r of parsed){
    const ipos=await p.$queryRawUnsafe<Row[]>(`SELECT id,currency FROM ipo_offerings WHERE source='JPX' AND symbol=$1 AND actual_listing_date=$2::date LIMIT 1`,r.ticker,r.listingDate);
    if(!ipos[0])continue;const ipo=ipos[0];
    await p.$executeRawUnsafe(`UPDATE ipo_offering_terms SET primary_shares=$1,secondary_shares=$2,total_shares_offered=$3,gross_proceeds=$4,source_type='DERIVED_ANALYTIC_AND_OFFICIAL_INPUTS',verification_status='DERIVED_VERIFIED_INPUTS',source_record_id=$5 WHERE ipo_id=$6::uuid AND price_type='FINAL_PRICE'`,r.primary,r.secondary,r.total,r.gross,`${r.recordId}:FINAL_OFFER_PRICE_X_PRIMARY_SHARES_V1`,ipo.id);
    const stocks=await p.$queryRawUnsafe<Row[]>(`SELECT id,currency FROM stocks WHERE ticker=$1 AND exchange='JPX' AND country='JP' AND is_active=true`,r.ticker);
    if(stocks.length!==1){await p.$executeRawUnsafe(`UPDATE ipo_stock_mappings SET status=$1,verification_status='VERIFIED_CHECK',missing_reason=$2,updated_at=now() WHERE ipo_id=$3::uuid`,stocks.length?"AMBIGUOUS":"NO_RECORD",stocks.length?"MULTIPLE_EXACT_MIC_TICKER_MATCHES":"NO_EXACT_MIC_TICKER_STOCK",ipo.id);continue;}
    const stock=stocks[0];verifiedLinks++;
    await p.$executeRawUnsafe(`UPDATE ipo_stock_mappings SET stock_id=$1,match_method='EXACT_MIC_PLUS_TICKER',status='VERIFIED',match_evidence=$2::jsonb,source='JPX_AND_CANONICAL_STOCK',source_url=$3,verification_status='VERIFIED_OFFICIAL',missing_reason=NULL,updated_at=now() WHERE ipo_id=$4::uuid`,stock.id,JSON.stringify({ticker:r.ticker,exchange:"JPX",country:"JP",listingDate:r.listingDate,verifiedAt:now()}),sourceUrl,ipo.id);
    if(stock.currency!==ipo.currency||!r.price)continue;
    const history=await p.$queryRawUnsafe<Row[]>(`SELECT date::text,close::float8 FROM stock_history WHERE stock_id=$1 AND date >= $2::date ORDER BY date LIMIT 91`,stock.id,r.listingDate);
    const metrics:[string,number,Row|undefined,string][]=[["FIRST_DAY_RETURN",0,history[0],"FIRST_VALID_MARKET_CLOSE_DIV_FINAL_OFFER_PRICE_MINUS_1_V1"],["RETURN_30D",30,history[30],"30_TRADING_SESSION_CLOSE_DIV_FINAL_OFFER_PRICE_MINUS_1_V1"],["RETURN_90D",90,history[90],"90_TRADING_SESSION_CLOSE_DIV_FINAL_OFFER_PRICE_MINUS_1_V1"]];
    for(const [metric,index,h,definition] of metrics){if(!h)continue;const value=h.close/r.price-1;await p.$executeRawUnsafe(`INSERT INTO ipo_performance(ipo_id,metric,value,observation_date,source_stock_id,source,verification_status,calculated_at) VALUES($1::uuid,$2,$3,$4::date,$5,$6,'DERIVED_VERIFIED_INPUTS',now()) ON CONFLICT(ipo_id,metric) DO UPDATE SET value=EXCLUDED.value,observation_date=EXCLUDED.observation_date,source=EXCLUDED.source,calculated_at=now()`,ipo.id,metric,value,h.date,stock.id,definition);if(index===0)firstDay++;if(index===30)return30++;if(index===90)return90++;}
  }
  await p.$executeRawUnsafe(`INSERT INTO ipo_coverage(ipo_id,identity_status,issuer_status,market_status,offering_terms_status,pricing_status,listing_status,revision_status,underwriter_status,stock_link_status,performance_status,provenance_status,freshness_status,coverage_status,checked_at) SELECT o.id,CASE WHEN o.issuer_id IS NOT NULL THEN 'READY' ELSE 'PARTIAL' END,CASE WHEN o.issuer_id IS NOT NULL THEN 'READY' ELSE 'PARTIAL' END,CASE WHEN o.market IS NOT NULL OR o.status IN('FILED','AMENDED') THEN 'READY' ELSE 'PARTIAL' END,CASE WHEN t.ipo_id IS NOT NULL THEN 'READY' ELSE 'TERMINALLY_UNAVAILABLE' END,CASE WHEN t.final_offer_price IS NOT NULL THEN 'READY' ELSE 'SOURCE_PENDING' END,CASE WHEN o.status='LISTED' THEN 'READY' ELSE 'NOT_LISTED_YET' END,CASE WHEN r.ipo_id IS NOT NULL THEN 'READY' ELSE 'PARTIAL' END,CASE WHEN u.ipo_id IS NOT NULL THEN 'READY' ELSE 'SOURCE_PENDING' END,COALESCE(m.status,'PENDING_NOT_LISTED'),CASE WHEN pf.ipo_id IS NOT NULL THEN 'READY' WHEN o.status='LISTED' THEN 'LINKED_INSUFFICIENT_HISTORY' ELSE 'NOT_LISTED' END,CASE WHEN o.verification_status='VERIFIED_OFFICIAL' THEN 'READY' ELSE 'PARTIAL' END,CASE WHEN o.status='LISTED' THEN 'LISTED_TERMINAL' WHEN o.status IN('FILED','AMENDED') THEN 'AWAITING_PRICING' ELSE 'SOURCE_PENDING' END,CASE WHEN o.issuer_id IS NOT NULL AND e.ipo_id IS NOT NULL AND r.ipo_id IS NOT NULL AND (o.status IN('FILED','AMENDED') OR t.ipo_id IS NOT NULL) THEN CASE WHEN o.status='LISTED' AND m.status<>'VERIFIED' THEN 'STOCK_LINK_CONSTRAINED' WHEN o.status='LISTED' THEN 'READY' ELSE 'SOURCE_CONSTRAINED' END ELSE 'NOT_READY' END,now() FROM ipo_offerings o LEFT JOIN (SELECT DISTINCT ipo_id FROM ipo_events)e ON e.ipo_id=o.id LEFT JOIN (SELECT DISTINCT ipo_id FROM ipo_revisions)r ON r.ipo_id=o.id LEFT JOIN (SELECT DISTINCT ON(ipo_id) ipo_id,final_offer_price FROM ipo_offering_terms ORDER BY ipo_id,as_of_date DESC)t ON t.ipo_id=o.id LEFT JOIN (SELECT DISTINCT ipo_id FROM ipo_underwriters)u ON u.ipo_id=o.id LEFT JOIN ipo_stock_mappings m ON m.ipo_id=o.id LEFT JOIN (SELECT DISTINCT ipo_id FROM ipo_performance)pf ON pf.ipo_id=o.id ON CONFLICT(ipo_id) DO UPDATE SET identity_status=EXCLUDED.identity_status,issuer_status=EXCLUDED.issuer_status,market_status=EXCLUDED.market_status,offering_terms_status=EXCLUDED.offering_terms_status,pricing_status=EXCLUDED.pricing_status,listing_status=EXCLUDED.listing_status,revision_status=EXCLUDED.revision_status,underwriter_status=EXCLUDED.underwriter_status,stock_link_status=EXCLUDED.stock_link_status,performance_status=EXCLUDED.performance_status,provenance_status=EXCLUDED.provenance_status,freshness_status=EXCLUDED.freshness_status,coverage_status=EXCLUDED.coverage_status,checked_at=now()`);
  console.log(JSON.stringify({processed:parsed.length,verifiedLinks,firstDay,return30,return90}));
}
main().finally(()=>p.$disconnect());
