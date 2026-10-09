import { PrismaClient } from "@prisma/client";
import { materializeTrackingLiquidityQuality } from "./tracking-liquidity-quality.ts";
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
materializeTrackingLiquidityQuality(prisma, process.argv.find(value => value.startsWith("--etf="))?.slice(6) || "IVV").then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
