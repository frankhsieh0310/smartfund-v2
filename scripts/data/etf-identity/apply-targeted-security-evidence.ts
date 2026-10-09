import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root = process.cwd();
const dir = path.join(root, "runtime", "etf-security-master-expansion");
const migration = "20260816180000_add_security_regulatory_evidence";
const migrationPath = path.join(root, "prisma", "migrations", migration, "migration.sql");
const sql = await fs.readFile(migrationPath, "utf8");
const checksum = createHash("sha256").update(sql).digest("hex");
const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const attempts: Array<Record<string, unknown>> = [];

await fs.mkdir(dir, { recursive: true });
for (let attempt = 1; attempt <= 6; attempt += 1) {
  const blockers = await db.$queryRawUnsafe<any[]>(`
    SELECT blocked.pid AS blocked_pid, blocker.pid AS blocking_pid,
           blocker.usename, blocker.application_name, blocker.state,
           blocker.xact_start, blocker.query_start,
           left(blocker.query, 300) AS query
    FROM pg_catalog.pg_locks blocked_lock
    JOIN pg_catalog.pg_stat_activity blocked ON blocked.pid = blocked_lock.pid
    JOIN pg_catalog.pg_locks blocker_lock
      ON blocker_lock.locktype = blocked_lock.locktype
     AND blocker_lock.database IS NOT DISTINCT FROM blocked_lock.database
     AND blocker_lock.relation IS NOT DISTINCT FROM blocked_lock.relation
     AND blocker_lock.page IS NOT DISTINCT FROM blocked_lock.page
     AND blocker_lock.tuple IS NOT DISTINCT FROM blocked_lock.tuple
     AND blocker_lock.virtualxid IS NOT DISTINCT FROM blocked_lock.virtualxid
     AND blocker_lock.transactionid IS NOT DISTINCT FROM blocked_lock.transactionid
     AND blocker_lock.classid IS NOT DISTINCT FROM blocked_lock.classid
     AND blocker_lock.objid IS NOT DISTINCT FROM blocked_lock.objid
     AND blocker_lock.objsubid IS NOT DISTINCT FROM blocked_lock.objsubid
     AND blocker_lock.pid <> blocked_lock.pid
    JOIN pg_catalog.pg_stat_activity blocker ON blocker.pid = blocker_lock.pid
    WHERE NOT blocked_lock.granted AND blocker_lock.granted`);
  try {
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout='5s'`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout='30s'`);
      const table = await tx.$queryRawUnsafe<any[]>(`SELECT to_regclass('public.security_regulatory_evidence')::text AS name`);
      const ledger = await tx.$queryRawUnsafe<any[]>(`SELECT checksum, finished_at FROM _prisma_migrations WHERE migration_name=$1 AND rolled_back_at IS NULL`, migration);
      if (ledger.length && ledger[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
      if (!table[0]?.name && ledger.length) throw new Error("LEDGER_WITHOUT_TABLE");
      if (!table[0]?.name) {
        for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
      }
      const columns = await tx.$queryRawUnsafe<any[]>(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='security_regulatory_evidence' ORDER BY ordinal_position`);
      const required = ["id", "security_id", "source", "accession", "source_record_id", "canonical_security_type", "retrieved_at"];
      if (!required.every((name) => columns.some((row) => row.column_name === name))) throw new Error("SCHEMA_READBACK_FAILED");
      if (!ledger.length) await tx.$executeRawUnsafe(`INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES ($1,$2,now(),$3,NULL,NULL,now(),1)`, randomUUID(), checksum, migration);
      return { columns: columns.map((row) => row.column_name), ledgerRecorded: !ledger.length };
    }, { timeout: 40000 });
    attempts.push({ attempt, at: new Date().toISOString(), blockers, status: "PASS" });
    const report = { status: "PASS", mode: "TARGETED_ADDITIVE_APPLY", migration, checksum, attempts, ...result, unrelatedMigrationsExecuted: 0, destructiveStatementsExecuted: 0, appliedAt: new Date().toISOString() };
    await fs.writeFile(path.join(dir, "targeted-schema-apply.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
    await db.$disconnect();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    attempts.push({ attempt, at: new Date().toISOString(), blockers, status: "ROLLED_BACK", error: message });
    if (!message.includes("55P03") && !message.toLowerCase().includes("lock timeout")) break;
    if (attempt < 6) await sleep(15_000);
  }
}
const report = { status: "RETRY_WAIT_LOCK_CONTENTION", mode: "TARGETED_ADDITIVE_APPLY", migration, checksum, attempts, unrelatedMigrationsExecuted: 0, destructiveStatementsExecuted: 0, updatedAt: new Date().toISOString() };
await fs.writeFile(path.join(dir, "targeted-schema-apply.json"), JSON.stringify(report, null, 2) + "\n");
console.error(JSON.stringify(report));
await db.$disconnect();
process.exitCode = 2;
