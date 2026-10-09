import { PrismaClient } from "@prisma/client";
const raw=process.env.DATABASE_URL;if(!raw)throw new Error("DATABASE_URL_REQUIRED");const url=new URL(raw);url.searchParams.set("pgbouncer","true");url.searchParams.set("connection_limit","1");const db=new PrismaClient({datasources:{db:{url:url.toString()}}});
try{const [totals,countries,quality,money]=await Promise.all([
 db.$queryRawUnsafe<any[]>(`SELECT count(DISTINCT s.id)::int series,count(v.id)::int rows FROM economic_series s LEFT JOIN economic_values v ON v.series_id=s.id`),
 db.$queryRawUnsafe<any[]>(`SELECT country,count(DISTINCT s.id)::int series,count(v.id)::int rows FROM economic_series s LEFT JOIN economic_values v ON v.series_id=s.id WHERE country IN('Taiwan','China','Japan','South Korea','Hong Kong','United Kingdom','Australia','Canada') GROUP BY country ORDER BY country`),
 db.$queryRawUnsafe<any[]>(`SELECT (SELECT count(*)::int FROM macro_observation_quality WHERE quality_state='FORECAST_OR_ESTIMATE') forecasts,(SELECT count(*)::int FROM macro_economy_identity_aliases) identities,(SELECT count(*)::int FROM macro_series_dispositions WHERE disposition='NO_OBSERVATION') no_observation`),
 db.$queryRawUnsafe<any[]>(`SELECT (SELECT count(*)::int FROM money_supply_series) series,(SELECT count(*)::int FROM money_supply_observations WHERE is_current) observations,(SELECT count(*)::int FROM money_supply_analytics) analytics`)
 ]);console.log(JSON.stringify({totals:totals[0],countries,quality:quality[0],money:money[0]}))}finally{await db.$disconnect()}
