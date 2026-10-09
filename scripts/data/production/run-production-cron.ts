import { spawn } from "node:child_process";

function run(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code ?? "signal"}`)));
  });
}

async function main(): Promise<void> {
  // Daily jobs are independent lifecycle units. A slow stock-market Daily run
  // must never starve ETF, Macro, Bond, Index, or Volatility Daily work.
  // Each runner retains its own distributed lock and controlled provider
  // concurrency; Historical remains strictly after the Daily dispatches.
  const financial = run("scripts/data/financial/run-production-financial.ts", []).catch((error: unknown) => {
    // Financial ingestion owns an independent lifecycle. A filing-provider
    // failure must be visible, but must never cancel price/asset Daily work.
    console.error(JSON.stringify({ pipeline: "OFFICIAL_FINANCIAL", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
  });
  const daily = await Promise.allSettled([
    run("scripts/data/earnings-calendar/run-global-earnings-calendar.ts", ["--once", "--incremental"]).catch((error: unknown) => {
      // Earnings owns its checkpoint, retry/dead-letter queues and single-writer
      // lock. Until migration approval it keeps producing local staging/archive.
      console.error(JSON.stringify({ pipeline: "GLOBAL_EARNINGS_CALENDAR", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
    run("scripts/data/daily/run-production-yahoo-daily.ts", ["--dispatch"]),
    run("scripts/data/daily/run-production-yahoo-asset-daily.ts", []),
    run("scripts/update-etf.ts", []),
    run("scripts/data/daily/run-production-macro-daily.ts", []),
    run("scripts/data/bis/run-shared-bis-official.ts", ["--resume"]).catch((error: unknown) => {
      // BIS owns a separate distributed lock and one pooled DB connection.
      // A BIS/source failure must not interrupt Bond, Yield, Spread or Daily.
      console.error(JSON.stringify({ pipeline: "SHARED_BIS_OFFICIAL", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
    run("scripts/data/bond/run-fixed-income-public-expansion.ts", ["--once"]).catch((error: unknown) => {
      // Priority-9 expansion is fail-closed and never claims while Fixed Income
      // is continuing. Its isolated failure cannot affect existing workers.
      console.error(JSON.stringify({ pipeline: "FIXED_INCOME_PUBLIC_EXPANSION", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
    run("scripts/data/fx/run-production-fx.ts", ["--incremental", "--resume", "--interval=1d", "--max-pairs=20"]),
    run("scripts/data/crypto/run-global-crypto.ts", ["--all"]).catch((error: unknown) => {
      // Crypto owns an independent 24/7 lifecycle and durable retry queue.
      // A venue outage must not cancel market-close or macro ingestion.
      console.error(JSON.stringify({ pipeline: "GLOBAL_CRYPTO", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
    run("scripts/data/index/run-index-p0-recovery.ts", ["--once"]).catch((error: unknown) => {
      console.error(JSON.stringify({ pipeline: "GLOBAL_INDEX_P0", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
    run("scripts/data/index/run-index-p0-structural-v2.ts", []).catch((error: unknown) => {
      console.error(JSON.stringify({ pipeline: "GLOBAL_INDEX_P0_STRUCTURAL", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
    run("scripts/data/index/run-index-p0-source-v3.ts", []).catch((error: unknown) => {
      console.error(JSON.stringify({ pipeline: "GLOBAL_INDEX_P0_SOURCE", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
    run("scripts/data/index/run-index-p0-closeout-v4.ts", []).catch((error: unknown) => {
      console.error(JSON.stringify({ pipeline: "GLOBAL_INDEX_P0_CLOSEOUT", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
    run("scripts/data/etf-flows/run-global-etf-flows.ts", ["--once"]).catch((error: unknown) => {
      console.error(JSON.stringify({ pipeline: "GLOBAL_ETF_FLOWS", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
    run("scripts/data/shipping-index/run-global-shipping-index.ts", ["--once"]).catch((error: unknown) => {
      // Shipping indices remain local-staging-only until licensing and the
      // production migration are explicitly approved.
      console.error(JSON.stringify({ pipeline: "GLOBAL_BALTIC_SHIPPING_INDEX", status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }),
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
