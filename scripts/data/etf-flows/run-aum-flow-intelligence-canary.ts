import { PrismaClient } from "@prisma/client";
import { materializeAumFlowIntelligence } from "./aum-flow-intelligence.ts";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
materializeAumFlowIntelligence(prisma, process.argv.find(value => value.startsWith("--etf="))?.slice(6) || "IVV")
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
