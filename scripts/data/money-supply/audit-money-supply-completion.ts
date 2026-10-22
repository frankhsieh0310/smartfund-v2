import { PrismaClient } from "@prisma/client";

const raw=process.env.DATABASE_URL;
if(!raw)throw new Error("DATABASE_URL_REQUIRED");
const url=new URL(raw);
url.searchParams.set("pgbouncer","true");
url.searchParams.set("connection_limit","1");
const db=new PrismaClient({datasources:{db:{url:url.toString()}}});
const ids=["M2SL","M1SL","BSI.M.U2.N.V.M30.X.1.U2.2300.Z01.E","BSI.M.U2.N.V.M10.X.1.U2.2300.Z01.E","BSI.M.U2.N.V.M20.X.1.U2.2300.Z01.E","V37151","V37152","V41552798","V41552801","LPMAUYN"];
try{
  const series=await db.$queryRawUnsafe(`SELECT s.provider,s.series_id,s.country,s.name,s.unit,s.frequency::text,count(v.*)::int rows,min(v.date)::text earliest,max(v.date)::text latest,count(v.imported_at)::int known_at,count(v.source_url)::int sourced,count(*) FILTER(WHERE v.value IS NULL)::int nulls,count(*) FILTER(WHERE v.value::text IN ('NaN','Infinity','-Infinity'))::int nonfinite FROM economic_series s LEFT JOIN economic_values v ON v.series_id=s.id WHERE s.series_id=ANY($1::text[]) GROUP BY s.provider,s.series_id,s.country,s.name,s.unit,s.frequency ORDER BY s.provider,s.series_id`,ids);
  const total=(await db.$queryRawUnsafe(`WITH x AS(SELECT v.* FROM economic_values v JOIN economic_series s ON s.id=v.series_id WHERE s.series_id=ANY($1::text[])) SELECT count(*)::int rows,count(DISTINCT series_id)::int series,min(date)::text earliest,max(date)::text latest,count(imported_at)::int known_at,count(source_url)::int sourced,count(*) FILTER(WHERE date>CURRENT_DATE)::int invalid_periods,count(*) FILTER(WHERE value IS NULL OR value::text IN ('NaN','Infinity','-Infinity'))::int invalid_values,(count(*)-count(DISTINCT(series_id,date)))::int duplicate_values FROM x`,ids))[0];
  console.log(JSON.stringify({series,total},null,2));
}finally{await db.$disconnect();}
