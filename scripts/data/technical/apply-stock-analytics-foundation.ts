import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const name = "20260816203000_stock_versioned_analytics_foundation";
const file = resolve("prisma", "migrations", name, "migration.sql");
const apply = process.argv.includes("--apply");
const readbackOnly = process.argv.includes("--readback");
function url(): string | undefined { const source=process.env.DATABASE_URL??process.env.DIRECT_URL;if(!source)return undefined;const parsed=new URL(source.replace(":5432/",":6543/"));parsed.searchParams.set("pgbouncer","true");parsed.searchParams.set("connection_limit","1");return parsed.toString(); }
const db = new PrismaClient({ datasources: { db: { url: url() } } });
const banned = /(?:^|;)\s*(?:DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+|ALTER\s+TABLE|RENAME\s+)/im;

async function metadata(tx: any) {
  const objects = await tx.$queryRawUnsafe<Array<{ analytics: string|null; seasonality: string|null }>>(`SELECT to_regclass('stock_analytics')::text analytics,to_regclass('stock_seasonality')::text seasonality`);
  const enums = await tx.$queryRawUnsafe<Array<{ typname:string }>>(`SELECT typname FROM pg_type WHERE typname IN ('StockAnalyticsTimeframe','StockAnalyticsMetricKind','StockSeasonalityType') ORDER BY typname`);
  const ledger = await tx.$queryRawUnsafe<Array<{checksum:string;finished_at:Date|null;rolled_back_at:Date|null}>>(`SELECT checksum,finished_at,rolled_back_at FROM "_prisma_migrations" WHERE migration_name=$1 ORDER BY started_at DESC`,name);
  const indexes = await tx.$queryRawUnsafe<Array<{tablename:string;indexname:string}>>(`SELECT tablename,indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('stock_analytics','stock_seasonality') ORDER BY tablename,indexname`);
  const constraints = await tx.$queryRawUnsafe<Array<{table_name:string;constraint_name:string;constraint_type:string}>>(`SELECT table_name,constraint_name,constraint_type FROM information_schema.table_constraints WHERE table_schema=current_schema() AND table_name IN ('stock_analytics','stock_seasonality') ORDER BY table_name,constraint_name`);
  const legacy = await tx.$queryRawUnsafe<Array<{estimated_rows:number}>>(`SELECT reltuples::bigint estimated_rows FROM pg_class WHERE oid='stock_technical'::regclass`);
  return { objects: objects[0], enums: enums.map(row=>row.typname), indexes, constraints, ledger, legacyEstimatedRows: Number(legacy[0]?.estimated_rows??0) };
}
async function main(){
  const sql=await readFile(file,"utf8"),checksum=createHash("sha256").update(sql).digest("hex");
  if(banned.test(sql))throw new Error("TARGET_MIGRATION_NOT_ADDITIVE");
  const statements=sql.split(/;\s*(?:\r?\n|$)/).map(value=>value.trim()).filter(Boolean);
  const before=await metadata(db);
  if(readbackOnly)return console.log(JSON.stringify({mode:"READBACK",migration:name,checksum,checksumMatch:before.ledger.length===1&&before.ledger[0]?.checksum===checksum,metadata:before},null,2));
  const absent=!before.objects?.analytics&&!before.objects?.seasonality&&before.enums.length===0&&before.ledger.length===0;
  if(!apply)return console.log(JSON.stringify({mode:"PREFLIGHT",migration:name,checksum,statements:statements.length,additiveOnly:true,before,safeToApply:absent},null,2));
  if(!absent)throw new Error(`TARGET_PREFLIGHT_COLLISION:${JSON.stringify(before)}`);
  const after=await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout='3s'`);
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout='30s'`);
    const lock=await tx.$queryRawUnsafe<Array<{acquired:boolean}>>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) acquired`,name);
    if(!lock[0]?.acquired)throw new Error("TARGET_MIGRATION_LOCK_BUSY");
    const repeated=await metadata(tx);if(repeated.objects?.analytics||repeated.objects?.seasonality||repeated.enums.length||repeated.ledger.length)throw new Error("TARGET_PREFLIGHT_CHANGED");
    for(const statement of statements)await tx.$executeRawUnsafe(statement);
    const schema=await metadata(tx);
    if(!schema.objects?.analytics||!schema.objects?.seasonality||schema.enums.length!==3||schema.legacyEstimatedRows!==before.legacyEstimatedRows)throw new Error(`TARGET_SCHEMA_READBACK_FAILED:${JSON.stringify(schema)}`);
    await tx.$executeRawUnsafe(`INSERT INTO "_prisma_migrations"(id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count) VALUES($1,$2,NOW(),$3,'TARGETED_ADDITIVE_APPLY',NULL,NOW(),$4)`,randomUUID(),checksum,name,statements.length);
    const final=await metadata(tx);if(final.ledger.length!==1||final.ledger[0]?.checksum!==checksum||!final.ledger[0]?.finished_at||final.ledger[0]?.rolled_back_at)throw new Error("TARGET_LEDGER_READBACK_FAILED");
    return final;
  },{maxWait:5000,timeout:45000});
  console.log(JSON.stringify({mode:"TARGETED_ADDITIVE_APPLY",migration:name,checksum,statements:statements.length,after},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>db.$disconnect());
