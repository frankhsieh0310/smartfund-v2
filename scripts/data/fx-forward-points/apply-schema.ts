import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const prisma = new PrismaClient();
const migration = "20260810100000_fx_forward_points_p0_semantic_recovery";

async function main() {
  const sql = await readFile(resolve("prisma/migrations", migration, "migration.sql"), "utf8");
  const statements = sql.split(/;\s*(?:\r?\n|$)/).map((item) => item.trim()).filter(Boolean);
  await prisma.$transaction(async (tx) => {
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
  }, { timeout: 30_000 });
  const proof = await prisma.$queryRawUnsafe<Array<{ relation: string | null; identity_relation: string | null }>>(
    `SELECT to_regclass('public.fx_forward_observations')::text AS relation,
            to_regclass('public.fx_forward_instruments')::text AS identity_relation`,
  );
  if (proof[0]?.relation !== "fx_forward_observations" || proof[0]?.identity_relation !== "fx_forward_instruments") throw new Error("RELATION_PROOF_FAILED");
  console.log(JSON.stringify({ migration, applied: true, ...proof[0] }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
