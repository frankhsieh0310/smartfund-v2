import { PrismaClient } from "@prisma/client";

const raw=process.argv.includes("--direct")?process.env.DIRECT_URL:process.env.DATABASE_URL;
if(!raw)throw new Error("DATABASE_URL_REQUIRED");
const url=new URL(raw);
if(!process.argv.includes("--direct")){url.searchParams.set("pgbouncer","true");url.searchParams.set("connection_limit","1");url.searchParams.set("pool_timeout","5")}
const db=new PrismaClient({datasources:{db:{url:url.toString()}}});
const timeout=new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("DB_DIAGNOSTIC_TIMEOUT_15S")),15000));
try{
 const rows=await Promise.race([db.$queryRawUnsafe(`SELECT pid,usename,application_name,state,wait_event_type,wait_event,backend_start,xact_start,query_start,client_addr::text FROM pg_stat_activity WHERE datname=current_database() ORDER BY backend_start`),timeout]);
 console.log(JSON.stringify(rows));
}finally{await db.$disconnect()}
