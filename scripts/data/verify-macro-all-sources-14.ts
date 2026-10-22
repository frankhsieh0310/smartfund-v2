import { PrismaClient } from "@prisma/client";
const raw=process.env.DATABASE_URL;if(!raw)throw new Error("DATABASE_URL_REQUIRED");const url=new URL(raw);url.searchParams.set("pgbouncer","true");url.searchParams.set("connection_limit","1");const db=new PrismaClient({datasources:{db:{url:url.toString()}}});
try{const [totals,providers,domains,range,economies]=await Promise.all([
 db.$queryRawUnsafe<any[]>(`SELECT (SELECT count(*) FROM economic_series)+(SELECT count(*) FROM economic_indicators)+(SELECT count(*) FROM sovereign_debt_series)+(SELECT count(*) FROM (SELECT country,metric_code,source FROM treasury_fiscal_observations GROUP BY country,metric_code,source)f) series,(SELECT count(*) FROM economic_values)+(SELECT count(*) FROM economic_indicators)+(SELECT count(*) FROM sovereign_debt_observations)+(SELECT count(*) FROM treasury_fiscal_observations) rows`),
 db.$queryRawUnsafe<any[]>(`SELECT provider,count(*)::int series FROM economic_series GROUP BY provider ORDER BY provider`),
 db.$queryRawUnsafe<any[]>(`SELECT category,count(*)::int series FROM economic_series GROUP BY category ORDER BY category`),
 db.$queryRawUnsafe<any[]>(`SELECT min(date) earliest,max(date) latest FROM economic_values`),
 db.$queryRawUnsafe<any[]>(`SELECT count(DISTINCT country)::int economies FROM economic_series`)
 ]);console.log(JSON.stringify({totals:totals[0],providers,domains,range:range[0],economies:economies[0].economies},(_,value)=>typeof value==="bigint"?Number(value):value))}finally{await db.$disconnect()}
