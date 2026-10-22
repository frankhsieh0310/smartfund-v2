import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const NAME = "20260816190000_stock_guidance_pit_and_sec_identity_foundation";
const FILE = path.resolve("prisma", "migrations", NAME, "migration.sql");
const apply = process.argv.includes("--apply");
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const banned = /(?:^|;)\s*(?:DROP|TRUNCATE|DELETE|UPDATE|ALTER\s+TABLE\s+[^;]+\s+DROP|ALTER\s+TABLE\s+[^;]+\s+RENAME)\b/im;

async function metadata(tx: PrismaClient | any) {
  const columns = await tx.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='company_guidance' AND column_name IN ('known_at','effective_as_of','known_at_precision','pit_evidence_status') ORDER BY column_name`);
  const tables = await tx.$queryRawUnsafe<Array<{ name: string | null }>>(`SELECT to_regclass('canonical_issuer_identifiers')::text name UNION ALL SELECT to_regclass('canonical_issuer_stock_links')::text`);
  const ledger = await tx.$queryRawUnsafe<Array<{ checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>>(`SELECT checksum,finished_at,rolled_back_at FROM "_prisma_migrations" WHERE migration_name=$1 ORDER BY started_at DESC`, NAME);
  const guidance = await tx.$queryRawUnsafe<Array<{ rows: number }>>(`SELECT COUNT(*)::int rows FROM company_guidance`);
  return { columns: columns.map(row => row.column_name), tables: tables.map(row => row.name).filter(Boolean), ledger, guidanceRows: guidance[0]?.rows ?? 0 };
}

async function main() {
  const sql = await readFile(FILE, "utf8"), checksum = createHash("sha256").update(sql).digest("hex");
  if (banned.test(sql)) throw new Error("TARGET_MIGRATION_NOT_ADDITIVE");
  const statements = sql.split(/;\s*(?:\r?\n|$)/).map(value => value.trim()).filter(Boolean);
  const before = await metadata(prisma);
  const already = before.ledger.find(row => row.finished_at && !row.rolled_back_at && row.checksum === checksum);
  if (!apply) return console.log(JSON.stringify({ mode: "PREFLIGHT", migration: NAME, additiveOnly: true, checksum, statements: statements.length, before, safeToApply: before.guidanceRows === 22 && before.columns.length === 0 && before.tables.length === 0 && before.ledger.length === 0 }, null, 2));
  if (already) return console.log(JSON.stringify({ mode: "ALREADY_APPLIED", migration: NAME, checksum, before }, null, 2));
  if (before.guidanceRows !== 22 || before.columns.length || before.tables.length || before.ledger.length) throw new Error(`TARGET_PREFLIGHT_COLLISION:${JSON.stringify(before)}`);
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout='3s'`);
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout='30s'`);
    const lock = await tx.$queryRawUnsafe<Array<{ acquired: boolean }>>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) acquired`, NAME);
    if (!lock[0]?.acquired) throw new Error("TARGET_MIGRATION_LOCK_BUSY");
    const repeated = await metadata(tx);
    if (repeated.guidanceRows !== 22 || repeated.columns.length || repeated.tables.length || repeated.ledger.length) throw new Error("TARGET_PREFLIGHT_CHANGED_IN_TRANSACTION");
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
    const schema = await metadata(tx);
    if (schema.columns.length !== 4 || schema.tables.length !== 2 || schema.guidanceRows !== 22) throw new Error(`TARGET_SCHEMA_READBACK_FAILED:${JSON.stringify(schema)}`);
    await tx.$executeRawUnsafe(`INSERT INTO "_prisma_migrations"(id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count) VALUES($1,$2,NOW(),$3,'TARGETED_ADDITIVE_APPLY',NULL,NOW(),$4)`, randomUUID(), checksum, NAME, statements.length);
    const final = await metadata(tx);
    if (final.ledger.length !== 1 || final.ledger[0].checksum !== checksum || !final.ledger[0].finished_at || final.ledger[0].rolled_back_at) throw new Error("TARGET_LEDGER_READBACK_FAILED");
    return final;
  }, { maxWait: 5_000, timeout: 45_000 });
  console.log(JSON.stringify({ mode: "TARGETED_ADDITIVE_APPLY", migration: NAME, checksum, statements: statements.length, result }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
