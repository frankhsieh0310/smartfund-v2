import { PrismaClient } from "@prisma/client";
import { readDatabaseOwnership } from "./database-checkpoint-adapter.ts";
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const references = ["DATABASE:production_scheduler_checkpoints:global_etf-production-daily", "DATABASE:production_scheduler_checkpoints:fx-production-daily", "DATABASE:crypto_work_items"];
const output: Record<string, unknown> = {};
for (const reference of references) output[reference] = await readDatabaseOwnership(prisma, reference);
console.log(JSON.stringify(output, null, 2));
await prisma.$disconnect();
