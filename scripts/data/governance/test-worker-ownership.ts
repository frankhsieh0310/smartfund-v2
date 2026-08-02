import { loadWorkerRegistry, validateWorkerOwnership, validateWorkerRegistry, type WorkerRegistry } from "./worker-ownership.ts";

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
  const results: Array<Record<string, unknown>> = [
    { name: "registry_schema_validation", status: "PASS", nodes: registry.nodes.length },
    expectError("missing_node_id", "SMARTFUND_NODE_ID_REQUIRED", () => validateWorkerOwnership(registry, { domain: "FINANCIAL", market: "NYSE", mode: "HISTORICAL", dryRun: true })),
    expectError("unknown_node_id", "SMARTFUND_NODE_ID_UNKNOWN", () => validateWorkerOwnership(registry, { nodeId: "unknown-node", domain: "FINANCIAL", market: "NYSE", mode: "HISTORICAL", dryRun: true })),
    expectError("wrong_market_assignment", "WORKER_ASSIGNMENT_MISMATCH", () => validateWorkerOwnership(registry, { nodeId: "worker-02-desktop", domain: "FINANCIAL", market: "NASDAQ", mode: "HISTORICAL", dryRun: true })),
  ];

  const ready = structuredClone(registry) as WorkerRegistry;
  const readyWorker = ready.nodes.find((node) => node.nodeId === "worker-02-desktop");
  if (!readyWorker) throw new Error("worker-02-desktop:NOT_FOUND");
  readyWorker.status = "READY";
  readyWorker.blockedReason = "MASTER_APPROVAL_REQUIRED";
  results.push(expectError("ready_live_write", "WORKER_NODE_NOT_ACTIVE", () => validateWorkerOwnership(ready, { nodeId: "worker-02-desktop", domain: "FINANCIAL", market: "NYSE", mode: "HISTORICAL", dryRun: false })));

  const collision = structuredClone(registry) as WorkerRegistry;
  collision.nodes.push({
    name: "COLLISION-TEST",
    nodeId: "collision-test",
    role: "HISTORICAL_WORKER",
    status: "ACTIVE",
    assignment: { domain: "FINANCIAL", market: "NYSE", mode: "HISTORICAL" },
  });
  results.push(expectError("ownership_collision", "WORKER_OWNERSHIP_COLLISION", () => validateWorkerRegistry(collision)));
  results.push({
    name: "active_owner_dry_run",
    status: "PASS",
    validation: validateWorkerOwnership(registry, { nodeId: "worker-02-desktop", domain: "FINANCIAL", market: "NYSE", mode: "HISTORICAL", dryRun: true }),
  });
  results.push({
    name: "active_owner_live_write",
    status: "PASS",
    validation: validateWorkerOwnership(registry, { nodeId: "worker-02-desktop", domain: "FINANCIAL", market: "NYSE", mode: "HISTORICAL", dryRun: false }),
  });

  console.log(JSON.stringify({ status: "PASS", results }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
