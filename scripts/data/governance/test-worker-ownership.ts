import { loadWorkerRegistry, validateWorkerOwnership, validateWorkerRegistry, type WorkerRegistry } from "./worker-ownership.ts";

const STOCK_MARKETS = [
  "TWSE", "TPEX", "NASDAQ", "NYSE", "AMEX", "JAPAN", "KOREA", "HONG_KONG",
  "CHINA_SHANGHAI", "CHINA_SHENZHEN", "SINGAPORE", "CANADA", "AUSTRALIA",
  "UNITED_KINGDOM", "GERMANY", "FRANCE", "NETHERLANDS", "SPAIN", "ITALY",
  "SWITZERLAND", "SWEDEN",
] as const;

function expectError(name: string, expected: string, action: () => unknown): { name: string; status: "PASS"; error: string } {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith(expected)) throw new Error(`${name}:EXPECTED_${expected}:RECEIVED_${message}`);
    return { name, status: "PASS", error: message };
  }
  throw new Error(`${name}:EXPECTED_ERROR:${expected}`);
}

async function main(): Promise<void> {
  const registry = await loadWorkerRegistry();
  const worker02 = registry.nodes.find((node) => node.nodeId === "worker-02-desktop");
  const master = registry.nodes.find((node) => node.nodeId === "smartfund-master");
  if (!worker02 || !master) throw new Error("REQUIRED_OWNER_NOT_FOUND");

  const results: Array<Record<string, unknown>> = [
    { name: "registry_schema_validation", status: "PASS", nodes: registry.nodes.length },
    { name: "worker02_role", status: worker02.role === "GLOBAL_STOCK_COMPLETION_WORKER" ? "PASS" : "FAIL", role: worker02.role },
    { name: "worker02_market_denominator", status: worker02.scopedAssignments?.length === STOCK_MARKETS.length ? "PASS" : "FAIL", markets: worker02.scopedAssignments?.length ?? 0 },
    { name: "master_non_stock_queue", status: master.authorizedQueue?.length === 11 ? "PASS" : "FAIL", domains: master.authorizedQueue },
    expectError("missing_node_id", "SMARTFUND_NODE_ID_REQUIRED", () => validateWorkerOwnership(registry, { domain: "STOCK", market: "NYSE", mode: "COMPLETION", dryRun: true })),
    expectError("unknown_node_id", "SMARTFUND_NODE_ID_UNKNOWN", () => validateWorkerOwnership(registry, { nodeId: "unknown-node", domain: "STOCK", market: "NYSE", mode: "COMPLETION", dryRun: true })),
    expectError("wrong_domain_rejection", "WORKER_ASSIGNMENT_MISMATCH", () => validateWorkerOwnership(registry, { nodeId: "worker-02-desktop", domain: "BOND", market: "US_TREASURY", mode: "HISTORICAL", dryRun: true })),
    expectError("wrong_market_rejection", "WORKER_ASSIGNMENT_MISMATCH", () => validateWorkerOwnership(registry, { nodeId: "worker-02-desktop", domain: "STOCK", market: "DENMARK", mode: "COMPLETION", dryRun: true })),
    expectError("wrong_mode_rejection", "WORKER_ASSIGNMENT_MISMATCH", () => validateWorkerOwnership(registry, { nodeId: "worker-02-desktop", domain: "STOCK", market: "NYSE", mode: "HISTORICAL", dryRun: true })),
    expectError("railway_historical_rejection", "WORKER_ASSIGNMENT_MISMATCH", () => validateWorkerOwnership(registry, { nodeId: "railway-production", domain: "STOCK", market: "NYSE", mode: "COMPLETION", dryRun: true })),
  ];

  const ready = structuredClone(registry) as WorkerRegistry;
  const readyWorker = ready.nodes.find((node) => node.nodeId === "worker-02-desktop");
  if (!readyWorker) throw new Error("worker-02-desktop:NOT_FOUND");
  readyWorker.status = "READY";
  readyWorker.blockedReason = "MASTER_APPROVAL_REQUIRED";
  results.push(expectError("ready_live_write", "WORKER_NODE_NOT_ACTIVE", () => validateWorkerOwnership(ready, { nodeId: "worker-02-desktop", domain: "STOCK", market: "NYSE", mode: "COMPLETION", dryRun: false })));

  const collision = structuredClone(registry) as WorkerRegistry;
  collision.nodes.push({
    name: "COLLISION-TEST",
    nodeId: "collision-test",
    role: "HISTORICAL_WORKER",
    status: "ACTIVE",
    assignment: { domain: "STOCK", market: "NYSE", mode: "COMPLETION" },
  });
  results.push(expectError("ownership_collision", "WORKER_OWNERSHIP_COLLISION", () => validateWorkerRegistry(collision)));

  for (const market of STOCK_MARKETS) {
    results.push({
      name: `worker02_${market.toLowerCase()}_live_write`,
      status: "PASS",
      validation: validateWorkerOwnership(registry, { nodeId: "worker-02-desktop", domain: "STOCK", market, mode: "COMPLETION", dryRun: false }),
    });
  }
  results.push({
    name: "master_bond_live_write",
    status: "PASS",
    validation: validateWorkerOwnership(registry, { nodeId: "smartfund-master", domain: "BOND", market: "US_TREASURY", mode: "HISTORICAL", dryRun: false }),
  });

  if (results.some((result) => result.status !== "PASS")) throw new Error(`OWNERSHIP_TEST_FAILED:${JSON.stringify(results.filter((result) => result.status !== "PASS"))}`);
  console.log(JSON.stringify({ status: "PASS", stockMarkets: STOCK_MARKETS.length, results }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
