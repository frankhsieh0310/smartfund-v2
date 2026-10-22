import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const url = new URL(process.env.DATABASE_URL ?? "");
url.searchParams.set("pgbouncer", "true");
url.searchParams.set("connection_limit", "1");
url.searchParams.set("pool_timeout", "20");
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
try {
  const sql = await readFile("prisma/migrations/20260818194000_derivatives_options_phase1/migration.sql", "utf8");
  for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement);
  console.log("OPTIONS_PHASE1_SCHEMA_APPLIED");
} finally {
  await prisma.$disconnect();
}
