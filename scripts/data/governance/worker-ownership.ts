import { readFile } from "node:fs/promises";
import path from "node:path";

export type WorkerMode = "HISTORICAL" | "INCREMENTAL" | "DAILY" | "RETRY" | "SCHEDULER" | "COMPLETION";
export type WorkerStatus = "ACTIVE" | "READY" | "BLOCKED" | "DISABLED";

export type WorkerScope = {
  domain: string;
  market: string;
  mode: WorkerMode;
};

export type WorkerNode = {
  name: string;
  nodeId: string;
  role: "MASTER" | "PRODUCTION" | "HISTORICAL_WORKER" | "GLOBAL_STOCK_COMPLETION_WORKER";
  status: WorkerStatus;
  assignments?: string[];
  assignment?: WorkerScope;
  scopedAssignments?: WorkerScope[];
  pausedAssignments?: Array<WorkerScope & { status: string; checkpoint?: string }>;
  authorizedQueue?: string[];
  authorizedLayers?: string[];
  failurePolicy?: {
    singleItemFailure: string;
    blockedScope: string;
  };
  blockedReason?: string;
};

export type WorkerRegistry = {
  version: number;
  policy: {
    scopeKey: string[];
    exclusiveOwnerPerScope: boolean;
    unknownNodesMayWrite: boolean;
    fallbackScopesForbidden: string[];
  };
  nodes: WorkerNode[];
};

export type OwnershipRequest = WorkerScope & {
  nodeId?: string;
  dryRun: boolean;
};

export type OwnershipValidation = WorkerScope & {
  nodeId: string;
  role: WorkerNode["role"];
  nodeStatus: WorkerStatus;
  ownershipValidated: true;
  liveWriteAuthorized: boolean;
};

const REGISTRY_PATH = path.resolve(process.cwd(), "config", "worker-assignments.json");
const FORBIDDEN_FALLBACKS = new Set(["ALL", "US", "GLOBAL"]);

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function normalizedScope(scope: WorkerScope): WorkerScope {
  return {
    domain: scope.domain.trim().toUpperCase(),
    market: scope.market.trim().toUpperCase(),
    mode: scope.mode.trim().toUpperCase() as WorkerMode,
  };
}

function nodeScopes(node: WorkerNode): WorkerScope[] {
  return [
    ...(node.assignment ? [node.assignment] : []),
    ...(node.scopedAssignments ?? []),
  ].map(normalizedScope);
}

export function validateWorkerRegistry(registry: WorkerRegistry): WorkerRegistry {
  if (!registry || typeof registry !== "object") fail("WORKER_REGISTRY_INVALID", "NOT_AN_OBJECT");
  if (registry.version !== 1) fail("WORKER_REGISTRY_INVALID", "UNSUPPORTED_VERSION");
  if (!Array.isArray(registry.nodes) || registry.nodes.length === 0) fail("WORKER_REGISTRY_INVALID", "NODES_REQUIRED");
  if (registry.policy?.exclusiveOwnerPerScope !== true || registry.policy?.unknownNodesMayWrite !== false) {
    fail("WORKER_REGISTRY_INVALID", "FAIL_CLOSED_POLICY_REQUIRED");
  }

  const nodeIds = new Set<string>();
  const scopeOwners = new Map<string, string>();
  for (const node of registry.nodes) {
    if (!node.nodeId?.trim()) fail("WORKER_REGISTRY_INVALID", "NODE_ID_REQUIRED");
    if (nodeIds.has(node.nodeId)) fail("WORKER_NODE_ID_COLLISION", node.nodeId);
    nodeIds.add(node.nodeId);
    if (!(["MASTER", "PRODUCTION", "HISTORICAL_WORKER", "GLOBAL_STOCK_COMPLETION_WORKER"] as string[]).includes(node.role)) {
      fail("WORKER_REGISTRY_INVALID", `ROLE:${node.nodeId}`);
    }
    if (!(["ACTIVE", "READY", "BLOCKED", "DISABLED"] as string[]).includes(node.status)) {
      fail("WORKER_REGISTRY_INVALID", `STATUS:${node.nodeId}`);
    }
    for (const scope of nodeScopes(node)) {
      if (!scope.domain || !scope.market || !scope.mode) fail("WORKER_REGISTRY_INVALID", `SCOPE:${node.nodeId}`);
      if (FORBIDDEN_FALLBACKS.has(scope.market)) fail("WORKER_FALLBACK_SCOPE_FORBIDDEN", `${node.nodeId}:${scope.market}`);
      if (node.role === "GLOBAL_STOCK_COMPLETION_WORKER" && (scope.domain !== "STOCK" || scope.mode !== "COMPLETION")) {
        fail("WORKER_ROLE_SCOPE_FORBIDDEN", `${node.nodeId}:${scope.domain}:${scope.market}:${scope.mode}`);
      }
      if (node.role === "PRODUCTION" && (scope.mode === "HISTORICAL" || scope.mode === "COMPLETION")) {
        fail("WORKER_ROLE_SCOPE_FORBIDDEN", `${node.nodeId}:${scope.domain}:${scope.market}:${scope.mode}`);
      }
      const key = `${scope.domain}:${scope.market}:${scope.mode}`;
      const existing = scopeOwners.get(key);
      if (existing && existing !== node.nodeId) fail("WORKER_OWNERSHIP_COLLISION", `${key}:${existing}:${node.nodeId}`);
      scopeOwners.set(key, node.nodeId);
    }
  }
  return registry;
}

export async function loadWorkerRegistry(registryPath = REGISTRY_PATH): Promise<WorkerRegistry> {
  const value = JSON.parse(await readFile(registryPath, "utf8")) as WorkerRegistry;
  return validateWorkerRegistry(value);
}

export function validateWorkerOwnership(registry: WorkerRegistry, request: OwnershipRequest): OwnershipValidation {
  validateWorkerRegistry(registry);
  const nodeId = request.nodeId?.trim();
  if (!nodeId) fail("SMARTFUND_NODE_ID_REQUIRED");
  const node = registry.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) fail("SMARTFUND_NODE_ID_UNKNOWN", nodeId);

  const expected = normalizedScope(request);
  if (FORBIDDEN_FALLBACKS.has(expected.market)) fail("WORKER_FALLBACK_SCOPE_FORBIDDEN", expected.market);
  const match = nodeScopes(node).some((scope) =>
    scope.domain === expected.domain && scope.market === expected.market && scope.mode === expected.mode,
  );
  if (!match) fail("WORKER_ASSIGNMENT_MISMATCH", `${nodeId}:${expected.domain}:${expected.market}:${expected.mode}`);
  if (node.status === "DISABLED") fail("WORKER_NODE_DISABLED", nodeId);
  if (node.status !== "ACTIVE" && !request.dryRun) {
    fail("WORKER_NODE_NOT_ACTIVE", `${nodeId}:${node.status}:${node.blockedReason ?? "MASTER_APPROVAL_REQUIRED"}`);
  }

  return {
    nodeId,
    role: node.role,
    nodeStatus: node.status,
    ...expected,
    ownershipValidated: true,
    liveWriteAuthorized: node.status === "ACTIVE",
  };
}

export async function validateWorkerOwnershipFromEnvironment(request: Omit<OwnershipRequest, "nodeId">): Promise<OwnershipValidation> {
  const registry = await loadWorkerRegistry();
  return validateWorkerOwnership(registry, { ...request, nodeId: process.env.SMARTFUND_NODE_ID });
}
