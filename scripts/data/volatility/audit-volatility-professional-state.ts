import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
const db=new PrismaClient();
try{
  const pid=26616;
  const checkpoint=JSON.parse(await readFile("runtime/volatility/checkpoint.json","utf8"));
  const history=await db.$queryRawUnsafe(`SELECT r.id,r.symbol,r.name,r.provider,coalesce(r.metadata->>'underlyingMarket',r.metadata->>'underlyingIndex','') underlying,r.currency,r.official_source_url source,r.verification_status source_status,count(o.observation_date)::int rows,count(DISTINCT o.observation_date)::int distinct_dates,min(o.observation_date)::text earliest,max(o.observation_date)::text latest,coalesce(round(100.0*count(*) FILTER(WHERE o.source IS NOT NULL AND o.source_record_id IS NOT NULL AND o.verification_status IS NOT NULL)/nullif(count(o.observation_date),0),2),0) provenance FROM global_index_registry r LEFT JOIN global_index_daily_observations o ON o.index_id=r.id AND o.quality_status='USABLE' WHERE r.id LIKE 'volidx:%' GROUP BY r.id ORDER BY r.symbol`) as any[];
  const quality=(await db.$queryRawUnsafe(`SELECT count(*) FILTER(WHERE value<0)::int invalid,count(*)-count(DISTINCT(index_id,observation_date,source))::int duplicate,count(*) FILTER(WHERE source IS NULL OR verification_status IS NULL)::int unknown_provenance,count(*) FILTER(WHERE quality_status IS NULL)::int unknown_quality FROM global_index_daily_observations WHERE index_id LIKE 'volidx:%'`) as any[])[0];
  const analytics=await db.$queryRawUnsafe(`SELECT metric,count(DISTINCT index_id)::int indices,count(*)::int rows FROM global_index_analytics WHERE index_id LIKE 'volidx:%' AND source LIKE 'DERIVED_CANONICAL_HISTORY|version=VOLIDX_PRO_ANALYTICS_V3%' GROUP BY metric ORDER BY metric`) as any[];
  const matrixRows=await db.$queryRawUnsafe(`SELECT details FROM global_index_coverage WHERE index_id LIKE 'volidx:%' AND capability='P0_TERMINAL_MATRIX'`) as any[];
  const domainCounts=matrixRows.map(x=>Object.keys(x.details?.domains??{}).length),matrix={rows:matrixRows.length,unknown_rows:matrixRows.filter(x=>JSON.stringify(x.details).includes('UNKNOWN')).length,min_domains:Math.min(...domainCounts),max_domains:Math.max(...domainCounts)};
  const events=await db.$queryRawUnsafe(`SELECT event_type,count(*)::int rows,count(DISTINCT index_id)::int indices FROM global_index_events WHERE index_id LIKE 'volidx:%' GROUP BY event_type`) as any[];
  const underlying=await db.$queryRawUnsafe(`SELECT r.id,r.symbol,count(o.observation_date)::int daily_rows,count(c.timestamp)::int candle_rows FROM global_index_registry r LEFT JOIN global_index_daily_observations o ON o.index_id=r.id LEFT JOIN global_index_candles c ON c.index_id=r.id AND c.interval='1d' WHERE r.id=ANY($1::text[]) GROUP BY r.id ORDER BY r.id`,["sp-500","nasdaq-100","russell-2000"]) as any[];
  console.log(JSON.stringify({pid,checkpoint,history,quality,analytics,matrix,events,underlying},(_,v)=>typeof v==='bigint'?Number(v):v,2));
}finally{await db.$disconnect()}
