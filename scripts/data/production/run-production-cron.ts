import { spawn } from "node:child_process";

function run(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code ?? "signal"}`)));
  });
}

async function main(): Promise<void> {
  // Daily production work is independent of Historical progress.  Preserve the
  // global priority order: stock daily, non-stock asset daily, then background
  // historical slices.
  await run("scripts/data/daily/run-production-yahoo-daily.ts", ["--all-due"]);
  await run("scripts/data/daily/run-production-yahoo-asset-daily.ts", []);
  await run("scripts/data/daily/run-production-macro-daily.ts", []);
  // The production runner retains its durable checkpoint between Cron invocations.
  // A larger bounded slice reaches the Historical Ready gate promptly without
  // introducing a second worker or bypassing the lifecycle lock.
  await run("scripts/data/historical/run-production-sp500-historical.ts", ["--market=NYSE", "--max-symbols=200"]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
