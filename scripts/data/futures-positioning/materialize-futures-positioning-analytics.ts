import { PrismaClient } from "@prisma/client";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { boundedDbRetry, futuresDatabaseUrl } from "../../../lib/data-platform/runtime/boundedFuturesDb.ts";

const dbUrl=futuresDatabaseUrl();
const prisma=new PrismaClient({datasources:{db:{url:dbUrl}}});
const runtime=path.join(process.cwd(),"runtime","futures-positioning"), now=()=>new Date().toISOString();
async function atomic(name:string,value:any){const file=path.join(runtime,name),temp=`${file}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(value,null,2));await rename(temp,file);}
async function main(){
  await atomic("analytics-checkpoint.json",{stage:"ANALYTICS_MATERIALIZATION",status:"RUNNING",pid:process.pid,updatedAt:now()});
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE futures_positioning_analytics`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO futures_positioning_analytics
    (observation_id,market_id,report_type,report_scope,category,as_of_date,net_position,long_pct_oi,short_pct_oi,spreading_pct_oi,net_pct_oi,net_change_1w,net_change_4w,net_change_13w,net_change_26w,net_change_52w,percentile_1y,percentile_3y,percentile_5y,sample_count_1y,sample_count_3y,sample_count_5y,formula_version,updated_at)
    WITH ordered AS (
      SELECT o.*,row_number() OVER (PARTITION BY market_id,report_type,report_scope,category ORDER BY report_date DESC,id) rn,
        lag(net_value,1) OVER w n1,lag(net_value,4) OVER w n4,lag(net_value,13) OVER w n13,lag(net_value,26) OVER w n26,lag(net_value,52) OVER w n52
      FROM futures_positioning_observations o WHERE market_id IS NOT NULL AND net_value IS NOT NULL
      WINDOW w AS (PARTITION BY market_id,report_type,report_scope,category ORDER BY report_date)
    ), latest AS (SELECT * FROM ordered WHERE rn=1)
    SELECT l.id,l.market_id,l.report_type,l.report_scope,l.category,l.report_date,l.net_value,
      CASE WHEN l.open_interest>0 THEN l.long_value::numeric/l.open_interest END,
      CASE WHEN l.open_interest>0 THEN l.short_value::numeric/l.open_interest END,
      CASE WHEN l.open_interest>0 AND l.spreading_value IS NOT NULL THEN l.spreading_value::numeric/l.open_interest END,
      CASE WHEN l.open_interest>0 THEN l.net_value::numeric/l.open_interest END,
      l.net_value-l.n1,l.net_value-l.n4,l.net_value-l.n13,l.net_value-l.n26,l.net_value-l.n52,
      CASE WHEN p.c1>=52 THEN p.le1::numeric/p.c1 END,CASE WHEN p.c3>=156 THEN p.le3::numeric/p.c3 END,CASE WHEN p.c5>=260 THEN p.le5::numeric/p.c5 END,
      p.c1,p.c3,p.c5,'cftc-positioning-v1',NOW()
    FROM latest l CROSS JOIN LATERAL (
      SELECT count(*) FILTER(WHERE o.report_date>l.report_date-INTERVAL '1 year')::int c1,
        count(*) FILTER(WHERE o.report_date>l.report_date-INTERVAL '3 years')::int c3,
        count(*) FILTER(WHERE o.report_date>l.report_date-INTERVAL '5 years')::int c5,
        count(*) FILTER(WHERE o.report_date>l.report_date-INTERVAL '1 year' AND o.net_value<=l.net_value)::int le1,
        count(*) FILTER(WHERE o.report_date>l.report_date-INTERVAL '3 years' AND o.net_value<=l.net_value)::int le3,
        count(*) FILTER(WHERE o.report_date>l.report_date-INTERVAL '5 years' AND o.net_value<=l.net_value)::int le5
      FROM futures_positioning_observations o WHERE o.market_id=l.market_id AND o.report_type=l.report_type AND o.report_scope=l.report_scope AND o.category=l.category AND o.report_date<=l.report_date
    ) p`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE futures_positioning_coverage`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO futures_positioning_coverage
    WITH c AS (
      SELECT market_id,report_type,report_scope,count(DISTINCT report_date)::int dates,min(report_date) earliest,max(report_date) latest,
        bool_and(open_interest IS NOT NULL) oi,bool_and(net_value IS NOT NULL) net,
        bool_and(source_url IS NOT NULL AND source_file IS NOT NULL AND checksum IS NOT NULL AND parser_version IS NOT NULL AND retrieved_at IS NOT NULL AND verification_state='VERIFIED_OFFICIAL') provenance
      FROM futures_positioning_observations WHERE market_id IS NOT NULL GROUP BY 1,2,3
    ), a AS (SELECT market_id,report_type,report_scope,bool_or(net_change_1w IS NOT NULL) change_ok,bool_or(net_pct_oi IS NOT NULL) pct_ok,bool_or(percentile_1y IS NOT NULL) percentile_ok FROM futures_positioning_analytics GROUP BY 1,2,3)
    SELECT c.market_id,c.report_type,c.report_scope,'COMPLETE',CASE WHEN c.latest>=CURRENT_DATE-14 THEN 'CURRENT' ELSE 'HISTORICAL_ONLY' END,
      CASE WHEN c.latest-c.earliest>=7300 THEN '>=20Y' WHEN c.latest-c.earliest>=3650 THEN '>=10Y' WHEN c.latest-c.earliest>=1825 THEN '>=5Y' WHEN c.latest-c.earliest>=1095 THEN '>=3Y' WHEN c.latest-c.earliest>=365 THEN '>=1Y' WHEN c.dates>=26 THEN '>=26_WEEKS' WHEN c.dates>=13 THEN '>=13_WEEKS' ELSE 'CURRENT_ONLY' END,
      CASE WHEN c.oi THEN 'COMPLETE' ELSE 'CONSTRAINED' END,CASE WHEN c.net THEN 'COMPLETE' ELSE 'CONSTRAINED' END,CASE WHEN a.change_ok THEN 'COMPLETE' ELSE 'HISTORY_CONSTRAINED' END,CASE WHEN a.pct_ok THEN 'COMPLETE' ELSE 'OI_CONSTRAINED' END,CASE WHEN a.percentile_ok THEN 'COMPLETE' ELSE 'HISTORY_CONSTRAINED' END,CASE WHEN c.provenance THEN 'COMPLETE' ELSE 'PARTIAL' END,
      CASE WHEN c.latest>=CURRENT_DATE-14 THEN 'WAITING_FOR_NEXT_CFTC_RELEASE' ELSE 'HISTORICAL_ONLY' END,
      CASE WHEN c.net AND c.provenance AND c.dates>1 THEN 'PROFESSIONAL_READY' WHEN c.net AND c.provenance THEN 'HISTORY_TIME_CONSTRAINED_READY' ELSE 'NOT_READY' END,
      c.dates,c.earliest,c.latest,NOW() FROM c JOIN a USING(market_id,report_type,report_scope)`);
  const result:any[]=await prisma.$queryRawUnsafe(`SELECT (SELECT count(*) FROM futures_positioning_analytics)::text analytics_rows,(SELECT count(*) FROM futures_positioning_coverage)::text coverage_rows,(SELECT count(*) FROM futures_positioning_coverage WHERE identity_state='UNKNOWN' OR current_state='UNKNOWN' OR history_state='UNKNOWN' OR open_interest_state='UNKNOWN' OR net_position_state='UNKNOWN' OR change_state='UNKNOWN' OR percent_oi_state='UNKNOWN' OR percentile_state='UNKNOWN' OR provenance_state='UNKNOWN' OR freshness_state='UNKNOWN' OR detail_state='UNKNOWN')::text unknown_states`);
  await atomic("analytics-checkpoint.json",{stage:"COMPLETE",status:"COMPLETE",formulaVersion:"cftc-positioning-v1",...result[0],updatedAt:now()});
}
boundedDbRetry(main).catch(async e=>{await atomic("analytics-checkpoint.json",{stage:"FAILED",status:"FAILED",attempts:3,error:String(e),updatedAt:now()});process.exitCode=1;}).finally(()=>prisma.$disconnect());
