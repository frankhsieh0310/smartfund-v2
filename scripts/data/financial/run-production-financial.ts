import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";

type Market = "NASDAQ" | "NYSE" | "AMEX";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const US_MARKETS: Market[] = ["NASDAQ", "NYSE", "AMEX"];

function run(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code ?? "signal"}`)));
  });
}

async function nextUsMarket(): Promise<Market | null> {
  for (const market of US_MARKETS) {
    const jobId = `official-financial-${market.toLowerCase()}-historical`;
    const rows = await prisma.$queryRawUnsafe<Array<{ complete: boolean }>>(
      "SELECT EXISTS(SELECT 1 FROM production_scheduler_runs WHERE job_id = $1 AND status = 'COMPLETED' AND validation_status = 'PASS') AS complete",
      jobId,
    );
    if (!rows[0]?.complete) return market;
  }
  return null;
}

async function main(): Promise<void> {
  const taiwan = await Promise.allSettled([
    run("scripts/data/financial/backfill-taiwan-official-financial.ts", ["--apply", "--resume", "--incremental", "--markets=TWSE"]),
    run("scripts/data/financial/backfill-taiwan-official-financial.ts", ["--apply", "--resume", "--incremental", "--markets=TPEX"]),
  ]);
  for (const [index, result] of taiwan.entries()) {
    if (result.status === "rejected") console.error(JSON.stringify({ pipeline: index === 0 ? "TWSE_FINANCIAL_INCREMENTAL" : "TPEX_FINANCIAL_INCREMENTAL", status: "FAILED", error: String(result.reason) }));
  }

  const market = await nextUsMarket();
  if (!market) {
    for (const incrementalMarket of US_MARKETS) {
      await run("scripts/data/financial/run-production-sec-financial.ts", [`--market=${incrementalMarket}`, "--incremental", "--max-symbols=100"]);
    }
    return;
  }
  await run("scripts/data/financial/run-production-sec-financial.ts", [`--market=${market}`, "--max-symbols=50"]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
