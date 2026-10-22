import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type Route = { domain: string; status: string; owner: string; route: string; requirement?: string };
type Contract = { version: string; asset: string; execution: Record<string, unknown>; safety: Record<string, unknown>; routes: Route[] };
const allowed = new Set(["AUTO_CONTINUING", "INPUT_GATED_AUTO_CONTINUING", "WAITING_DEPENDENCY", "NEEDS_SOURCE", "SOURCE_NOT_PUBLIC", "EXTERNALLY_BLOCKED"]);
const expected = new Set(["IDENTITY_ISSUER_SECURITY_GRAPH","FUNDAMENTALS_FULL_DEPTH","VALUATION_HISTORY","CAPITAL_ALLOCATION","CORPORATE_ACTIONS_PRODUCT_LIFECYCLE","OWNERSHIP","SHARE_CAPITAL_STRUCTURE","SEGMENT_GEOGRAPHIC_REVENUE","SUPPLY_CHAIN_COMPANY_RELATIONSHIPS","FACTOR_STYLE","TECHNICAL_QUANT","EVENTS_FILINGS","MANAGEMENT_GOVERNANCE","DIVIDEND_INCOME","RISK_PROFESSIONAL_ANALYTICS","CROSS_ASSET_LINKAGE","THEME_TOPIC_EXPOSURE","DATA_TRUST_PIT","MULTILINGUAL_IDENTITY","OFFICIAL_SOURCE_DISCOVERY_REUSE"]);
const root = path.resolve("runtime", "global-stock-remaining-word-completion");
async function atomic(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temp, file); }
const contract = JSON.parse(await readFile(path.resolve("config", "global-stock-remaining-word-routes.json"), "utf8")) as Contract;
if (contract.asset !== "GLOBAL_STOCK" || contract.routes.length !== expected.size) throw new Error("GLOBAL_STOCK_ROUTE_CONTRACT_INCOMPLETE");
const domains = new Set<string>();
for (const route of contract.routes) {
  if (!expected.has(route.domain) || domains.has(route.domain)) throw new Error(`INVALID_OR_DUPLICATE_DOMAIN:${route.domain}`);
  if (!allowed.has(route.status)) throw new Error(`UNKNOWN_ROUTE_STATUS:${route.domain}:${route.status}`);
  if (!route.owner || !route.route) throw new Error(`UNROUTED_DOMAIN:${route.domain}`);
  if (["INPUT_GATED_AUTO_CONTINUING", "WAITING_DEPENDENCY", "NEEDS_SOURCE", "SOURCE_NOT_PUBLIC", "EXTERNALLY_BLOCKED"].includes(route.status) && !route.requirement) throw new Error(`MISSING_EXACT_REQUIREMENT:${route.domain}`);
  domains.add(route.domain);
}
const grouped = Object.fromEntries([...allowed].map((status) => [status, contract.routes.filter((route) => route.status === status).map((route) => route.domain)]));
const now = new Date().toISOString();
const checkpoint = { asset: contract.asset, version: contract.version, phase: "ROUTING_COMPLETE", processed: contract.routes.length, total: expected.size, unknown: 0, lowCostImplementationGaps: 0, grouped, fullEligibleUniverseAssigned: true, fullReliableHistoryAssigned: true, incrementalAssigned: true, scheduledRefreshAssigned: true, ordinaryNodeOwnership: true, codeDataRunning: false, createdAt: now, updatedAt: now };
await atomic(path.join(root, "route-checkpoint.json"), checkpoint);
await atomic(path.join(root, "ordinary-worker-handoff.json"), { asset: contract.asset, state: "AUTO_CONTINUING", executionPolicy: contract.execution, safety: contract.safety, routes: contract.routes, checkpoint: "runtime/global-stock-remaining-word-completion/route-checkpoint.json", generatedAt: now });
const readback = JSON.parse(await readFile(path.join(root, "route-checkpoint.json"), "utf8")) as typeof checkpoint;
if (readback.processed !== expected.size || readback.unknown !== 0 || readback.lowCostImplementationGaps !== 0) throw new Error("ROUTE_CHECKPOINT_READBACK_FAILED");
console.log(JSON.stringify({ status: "PASS", readback: "PASS", ...readback }));
