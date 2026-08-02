import { spawn } from "node:child_process";
import { loadWorkerRegistry, type WorkerNode, type WorkerScope } from "../governance/worker-ownership.ts";

type Market = "NASDAQ" | "NYSE" | "AMEX";

const US_MARKETS: Market[] = ["NASDAQ", "NYSE", "AMEX"];
const DRY_RUN = process.argv.includes("--dry-run");

function run(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code ?? "signal"}`)));
  });
}

function scopes(node: WorkerNode): WorkerScope[] {
  return [...(node.assignment ? [node.assignment] : []), ...(node.scopedAssignments ?? [])];
}

function ownerFor(nodes: WorkerNode[], expected: WorkerScope): WorkerNode | undefined {
  return nodes.find((node) => scopes(node).some((scope) =>
    scope.domain.toUpperCase() === expected.domain &&
    scope.market.toUpperCase() === expected.market &&
    scope.mode.toUpperCase() === expected.mode,
  ));
}

async function main(): Promise<void> {
  const nodeId = process.env.SMARTFUND_NODE_ID?.trim();
  if (nodeId !== "railway-production") throw new Error(`RAILWAY_NODE_ID_REQUIRED:${nodeId ?? "MISSING"}`);
  const registry = await loadWorkerRegistry();
  for (const market of US_MARKETS) {
    const owner = ownerFor(registry.nodes, { domain: "FINANCIAL", market, mode: "HISTORICAL" });
    console.log(JSON.stringify({
      pipeline: `official-financial-${market.toLowerCase()}-historical`,
      status: "SKIPPED_BY_OWNERSHIP",
      owner: owner?.nodeId ?? null,
      railwayOwner: false,
    }));
  }
  if (DRY_RUN) {
    for (const market of US_MARKETS) {
      const owner = ownerFor(registry.nodes, { domain: "FINANCIAL", market, mode: "INCREMENTAL" });
      if (owner?.nodeId !== nodeId || owner.status !== "ACTIVE") {
        throw new Error(`RAILWAY_INCREMENTAL_OWNERSHIP_INVALID:${market}:${owner?.nodeId ?? "NONE"}:${owner?.status ?? "NONE"}`);
      }
      console.log(JSON.stringify({ pipeline: `official-financial-${market.toLowerCase()}-incremental`, status: "DRY_RUN_WOULD_RUN", owner: nodeId, databaseWrites: 0 }));
    }
    console.log(JSON.stringify({ status: "DRY_RUN_COMPLETE", historicalStarted: 0, incrementalValidated: US_MARKETS.length, databaseWrites: 0 }));
    return;
  }

  const taiwan = await Promise.allSettled([
    run("scripts/data/financial/backfill-taiwan-official-financial.ts", ["--apply", "--resume", "--incremental", "--markets=TWSE"]),
    run("scripts/data/financial/backfill-taiwan-official-financial.ts", ["--apply", "--resume", "--incremental", "--markets=TPEX"]),
  ]);
  for (const [index, result] of taiwan.entries()) {
    if (result.status === "rejected") console.error(JSON.stringify({ pipeline: index === 0 ? "TWSE_FINANCIAL_INCREMENTAL" : "TPEX_FINANCIAL_INCREMENTAL", status: "FAILED", error: String(result.reason) }));
  }

  for (const incrementalMarket of US_MARKETS) {
    await run("scripts/data/financial/run-production-sec-financial.ts", [`--market=${incrementalMarket}`, "--incremental", "--max-symbols=100"]);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
