import { spawn } from "node:child_process";
import path from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const snapshot = process.argv.find((value) => value.startsWith("--snapshot-date="));

const jobs = [
  { market: "US_TREASURY", script: "scripts/data/bond/run-production-us-treasury.ts", runtime: "us-treasury" },
  { market: "TAIWAN_GOVERNMENT", script: "scripts/data/bond/run-production-taiwan-government.ts", runtime: "taiwan-government" },
] as const;

async function run(job: (typeof jobs)[number]): Promise<{ market: string; exitCode: number }> {
  const args = ["--experimental-strip-types", job.script];
  if (DRY_RUN) args.push("--dry-run");
  if (snapshot) args.push(snapshot);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SMARTFUND_NODE_ID: process.env.SMARTFUND_NODE_ID ?? "railway-bond-production",
      BOND_LIVE_WRITE_AUTHORIZED: process.env.BOND_LIVE_WRITE_AUTHORIZED ?? "true",
      BOND_ARCHIVE_ROOT: process.env.BOND_ARCHIVE_ROOT ?? path.resolve("runtime", "bond", job.runtime, "durable-archive"),
    },
    stdio: "inherit",
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return { market: job.market, exitCode };
}

async function main(): Promise<void> {
  const results: Array<{ market: string; exitCode: number }> = [];
  for (const job of jobs) {
    try {
      results.push(await run(job));
    } catch (error) {
      console.error(`BOND_MARKET_JOB_FAILED:${job.market}`, error);
      results.push({ market: job.market, exitCode: 1 });
    }
  }
  const failed = results.filter((result) => result.exitCode !== 0);
  console.log(JSON.stringify({ status: failed.length ? "COMPLETE_WITH_EXCEPTIONS" : "PASS", mode: DRY_RUN ? "DRY_RUN" : "PRODUCTION", results }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
