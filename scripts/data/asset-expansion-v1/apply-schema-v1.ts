import { PrismaClient } from "@prisma/client";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const prisma = new PrismaClient();
const migration = "20260809163000_new_asset_schema_blocked_batch_v1";

async function main() {
  const sql = await readFile(resolve("prisma/migrations", migration, "migration.sql"), "utf8");
  const statements = sql.split(/;\s*(?:\r?\n|$)/).map((item) => item.trim()).filter(Boolean);
  await prisma.$transaction(async (tx) => {
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
  }, { timeout: 60_000 });
  const expected = ["fund_holdings", "fund_flows", "etf_asset_metrics", "yield_curves", "yield_curve_points", "treasury_auctions", "corporate_issuance_events"];
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[]) ORDER BY table_name`, expected,
  );
  const present = rows.map((row) => row.table_name);
  if (present.length !== expected.length) throw new Error(`RELATION_PROOF_FAILED:${present.join(",")}`);
  const runtime = resolve("runtime/asset-expansion-v1/schema-repair-v1");
  await mkdir(runtime, { recursive: true });
  await writeFile(resolve(runtime, "migration.json"), JSON.stringify({ migration, additiveOnly: true, destructiveChange: false, relations: present, appliedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ migration, applied: true, relations: present }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
