import { spawn } from "node:child_process";

function run(script: string, args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], { cwd: process.cwd(), stdio: "inherit", env: environment });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code ?? "signal"}`)));
  });
}

async function main(): Promise<void> {
  // Daily jobs are independent lifecycle units. A slow stock-market Daily run
  // must never starve ETF, Macro, Bond, Index, or Volatility Daily work.
  // Each runner retains its own distributed lock and controlled provider
  // concurrency; Historical remains strictly after the Daily dispatches.
  const financial = run("scripts/data/financial/run-production-financial.ts", [], { ...process.env, SMARTFUND_NODE_ID: "railway-production" }).catch((error: unknown) => {
    // Financial ingestion owns an independent lifecycle. A filing-provider
    // failure must be visible, but must never cancel price/asset Daily work.
    console.error(JSON.stringify({ pipeline: "OFFICIAL_FINANCIAL", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
  });
  const daily = await Promise.allSettled([
    run("scripts/data/daily/run-production-yahoo-daily.ts", ["--dispatch"]),
    run("scripts/data/daily/run-production-yahoo-asset-daily.ts", []),
    run("scripts/data/daily/run-production-macro-daily.ts", []),
  ]);
  const rejected = daily.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
  await financial;
  // The production runner retains its durable checkpoint between Cron invocations.
  // A larger bounded slice reaches the Historical Ready gate promptly without
  // introducing a second worker or bypassing the lifecycle lock.
  await run("scripts/data/historical/run-production-sp500-historical.ts", ["--market=NYSE", "--max-symbols=200"]).catch((error: unknown) => {
    // Historical validation is lower priority than every Daily and official
    // filing lifecycle. Preserve its checkpoint and expose the failure without
    // crashing the independent production pipelines in this Cron invocation.
    console.error(JSON.stringify({ pipeline: "NYSE_HISTORICAL", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
