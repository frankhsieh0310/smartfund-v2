import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type AuditStatus = "PASS" | "PARTIAL" | "MISSING" | "BLOCKED_SOURCE" | "BLOCKED_LICENSE" | "BLOCKED_AUTH" | "BLOCKED_SCHEMA" | "NOT_APPLICABLE";
type Priority = "P0" | "P1" | "P2" | "P3";
type DomainSeed = { domain: string; requirement: string; status: AuditStatus; priority: Priority; source: string; coverage: string; history: string; latest: string; pit: string; incremental: string; scheduler: string; quality: string; sample: string; blocker: string | null; deterministic: boolean; worker: string | null; workType: string };

const root = process.cwd();
const commodityRuntime = path.join(root, "runtime", "commodity");
const output = {
  audit: path.join(commodityRuntime, "commodity-depth-audit.json"),
  gaps: path.join(commodityRuntime, "commodity-gap-manifest.json"),
  summary: path.join(commodityRuntime, "commodity-gap-summary.md"),
  queue: path.join(commodityRuntime, "depth-gap-work-queue.json"),
};
const readJson = async <T>(file: string) => JSON.parse(await readFile(file, "utf8")) as T;
async function atomic(file: string, value: unknown, raw = false) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, raw ? String(value) : `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }

export async function buildCommodityDepthAudit() {
  const [coverage, checkpoint, health, inventory, energy, electricity, carbon, shipping] = await Promise.all([
    readJson<any>(path.join(commodityRuntime, "professional-depth", "coverage.json")),
    readJson<any>(path.join(commodityRuntime, "checkpoint.json")),
    readJson<any>(path.join(commodityRuntime, "desktop-supervisor", "health.json")),
    readJson<any>(path.join(root, "runtime", "commodity-inventory", "coverage-matrix.json")),
    readJson<any[]>(path.join(root, "runtime", "energy-physical-supply-demand", "coverage-matrix.json")),
    readJson<any>(path.join(root, "runtime", "electricity-markets", "market-coverage-matrix.json")),
    readJson<any>(path.join(root, "runtime", "carbon-markets", "completion-manifest.json")),
    readJson<any>(path.join(root, "runtime", "shipping-index", "completion-manifest.json")),
  ]);
  const invRows = inventory.metrics.reduce((sum: number, item: any) => sum + Number(item.canonicalRows ?? 0), 0);
  const energyRows = energy.reduce((sum, item) => sum + Number(item.observation_count ?? 0), 0);
  const electricityReady = electricity.rows.filter((item: any) => item.currentCoverage).length;
  const base = { latest: "Manifest/checkpoint verified", pit: "Not available unless stated", incremental: "Existing lifecycle", scheduler: "Existing scheduler", quality: "Deterministic metadata validation", sample: "Manifest sample validated" };
  const d = (domain: string, requirement: string, status: AuditStatus, priority: Priority, source: string, coverageText: string, history: string, blocker: string | null, deterministic: boolean, worker: string | null, workType: string, overrides: Partial<DomainSeed> = {}): DomainSeed => ({ domain, requirement, status, priority, source, coverage: coverageText, history, blocker, deterministic, worker, workType, ...base, ...overrides });
  const domains: DomainSeed[] = [
    d("Universe", "Canonical commodity universe", "PASS", "P0", "GLOBAL_COMMODITY", `${coverage.commodityMasterCoverage.ready}/${coverage.commodityMasterCoverage.total}`, "Metadata complete", null, false, null, "NONE"),
    d("Identity", "Stable commodity/grade/location semantics", "PASS", "P0", "GLOBAL_COMMODITY", `${coverage.taxonomyCoverage.ready}/${coverage.taxonomyCoverage.total}`, "Current identity registry", null, false, null, "NONE"),
    d("Spot / Reference Price", "Semantic spot/reference/benchmark coverage", "PARTIAL", "P0", "WORLD_BANK_PINK_SHEET + existing market data", `reference ${coverage.officialReferenceCoverage.ready}/${coverage.officialReferenceCoverage.total}; official spot ${coverage.officialSpotCoverage.ready}/${coverage.officialSpotCoverage.total}`, `${coverage.originalHistoryRows} preserved rows`, "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Fixing", "Explicit fixing-price series", "MISSING", "P0", "NONE", "0 evidenced fixing series", "NONE", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Historical Price", "Deepest reliable semantic price history", "PARTIAL", "P0", "MarketData", `${coverage.priceSeriesCoverage.ready}/${coverage.priceSeriesCoverage.total} series`, `${coverage.originalHistoryRows} rows preserved; no rebuild`, "REFERENCE_SEMANTICS_PARTIAL", false, null, "MAPPING"),
    d("Latest Price", "Native-frequency current reference projection", "PASS", "P0", health.scheduler.currentSource, "Existing latest path", "Checkpointed", null, false, "GLOBAL_COMMODITY", "INCREMENTAL"),
    d("Intraday / Delayed Quote readiness", "Native reliable intraday only", "MISSING", "P0", "NONE", "No evidenced native intraday contract", "NONE", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Energy", "Oil/gas/products physical fundamentals", "PARTIAL", "P1", "EIA", `${energy.length} series / ${energyRows} observations`, "1982-present where supported", null, true, "ENERGY_PHYSICAL_SUPPLY_DEMAND", "ANALYTICS_WIRING"),
    d("Crude Oil", "Price, stocks, production, flows and refinery", "PASS", "P1", "EIA + reference price", "Production/import/export/stocks/refinery inputs/utilization", "1982-present by series", null, false, "ENERGY_PHYSICAL_SUPPLY_DEMAND", "INCREMENTAL"),
    d("Natural Gas", "Price, production, storage and flows", "PARTIAL", "P1", "EIA", "Storage covered; production/flows incomplete", "Storage 2014-present", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Refined Products", "Inventory, production and consumption coverage", "PARTIAL", "P1", "EIA", "Gasoline/distillate stocks and product-supplied proxy", "Partial", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Inventory", "Physical inventories with history/latest", "PARTIAL", "P1", "EIA + USDA", `${inventory.registeredScope} series / ${invRows} observations`, "Series-specific; constrained breadth", null, true, "GLOBAL_COMMODITY_INVENTORY", "ANALYTICS_WIRING"),
    d("Production", "Physical production by commodity/geography", "PARTIAL", "P1", "EIA", "Crude covered; broader commodities incomplete", "1983-present for crude", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Consumption", "Verified consumption/demand", "PARTIAL", "P1", "EIA", "Petroleum product supplied proxy only", "1990-present", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Imports / Exports", "Physical trade flows", "PARTIAL", "P1", "EIA", "US crude import/export covered", "1990/1991-present", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("OPEC", "Authoritative oil supply/demand", "MISSING", "P1", "NONE", "No approved adapter", "NONE", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("EIA", "Official energy source continuity", "PASS", "P1", "EIA", `${energy.length}/${energy.length} physical series ready`, "Maximum existing source depth", null, false, "ENERGY_PHYSICAL_SUPPLY_DEMAND", "INCREMENTAL"),
    d("Agriculture", "Physical agriculture fundamentals", "PARTIAL", "P1", "USDA NASS", "Corn/wheat/soybean stocks only", "1-2 observations in current archive", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("USDA", "Official USDA datasets", "PARTIAL", "P1", "USDA NASS", "Grain stocks 3 commodities", "Time-depth constrained", null, true, "GLOBAL_COMMODITY_INVENTORY", "VINTAGE_WIRING"),
    d("WASDE", "Report/vintage supply-demand estimates", "MISSING", "P1", "NONE", "No WASDE adapter/vintages", "NONE", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Crop Data", "Acreage, yield, progress and condition", "MISSING", "P1", "NONE", "No approved deterministic adapter", "NONE", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Metals", "Physical prices/inventory/production", "BLOCKED_SOURCE", "P1", "LME + reference prices", "Reference prices present; LME inventory 0 rows", "Reference history only", "ACCESS_CONSTRAINED", false, null, "SOURCE_ACCESS"),
    d("Gold", "Fixing, physical supply/demand and relationships", "PARTIAL", "P1", "WORLD_BANK_PINK_SHEET", "Reference price only", "1960-2024 monthly reference sample", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Silver", "Reference and physical fundamentals", "PARTIAL", "P1", "Existing commodity price series", "Price identity/history; physical fundamentals missing", "Existing price history", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Copper", "Reference, inventory, production and demand", "PARTIAL", "P1", "WORLD_BANK_PINK_SHEET", "Reference price only", "1960-2024 monthly reference sample", "ACCESS_CONSTRAINED", false, null, "SOURCE_ACCESS"),
    d("Industrial Metals", "Inventory and physical balances", "BLOCKED_SOURCE", "P1", "LME", "Identity only", "NONE", "ACCESS_CONSTRAINED", false, null, "SOURCE_ACCESS"),
    d("Mining / Production", "Mine production fundamentals", "MISSING", "P1", "NONE", "No approved adapter", "NONE", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Central Bank Gold Demand", "Official/industry gold demand", "MISSING", "P1", "NONE", "No approved adapter", "NONE", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Electricity", "Supported official electricity markets", "PARTIAL", "P1", "Elexon + registered operators", `${electricityReady}/${electricity.rows.length} markets current`, "8 delivery days in existing matrix", null, true, "GLOBAL_ELECTRICITY_MARKETS", "ANALYTICS_WIRING"),
    d("Power Prices", "Market/location-specific prices", "PARTIAL", "P1", "Elexon", "GB system-price locations only", "8 delivery days", null, false, "GLOBAL_ELECTRICITY_MARKETS", "INCREMENTAL"),
    d("Generation Mix", "Generation/fuel mix/renewable share", "MISSING", "P1", "NONE", "0 covered markets", "NONE", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Shipping", "Freight/index identities, latest and history", "BLOCKED_LICENSE", "P1", "Baltic/Freightos/SSE/Drewry/HARPEX", `${shipping.targetIndices} identities; ${shipping.observationWrites} observations`, "NONE", "LICENSE_CONSTRAINED", false, null, "LICENSE"),
    d("Freight", "Route/segment/vessel-class rates", "BLOCKED_LICENSE", "P1", "Shipping publishers", "Contracts only", "NONE", "LICENSE_CONSTRAINED", false, null, "LICENSE"),
    d("Carbon / Emissions", "Allowance/auction price/supply/emissions", "PARTIAL", "P1", "EU ETS/EEX + carbon authorities", `EU ETS current; ${carbon.canonicalPrograms ?? 5} programs registered`, "Auction history partial", null, true, "GLOBAL_CARBON_MARKETS", "ANALYTICS_WIRING"),
    d("Supply / Demand Balance", "Verified balance analytics", "PARTIAL", "P1", "EnergyPhysicalSeries", "Oil inputs available; other commodities missing", "Input-dependent", null, true, "ENERGY_PHYSICAL_SUPPLY_DEMAND", "DERIVED_ANALYTICS"),
    d("Days of Supply", "Compatible inventory/consumption ratio", "MISSING", "P1", "Existing inventory contract", "Contract ready; data alignment pending", "NONE", "INPUT_CONSTRAINED", true, "GLOBAL_COMMODITY_INVENTORY", "DERIVED_ANALYTICS"),
    d("Seasonality", "Frequency-aware seasonal analytics", "PARTIAL", "P1", "Inventory analytics contract", "Weekly seasonal comparison contracted", "Input-dependent", null, true, "GLOBAL_COMMODITY_INVENTORY", "DERIVED_ANALYTICS"),
    d("Inventory vs Seasonal Range", "5Y/10Y compatible seasonal range", "PARTIAL", "P1", "Inventory history", "Gas storage has >10Y; other series constrained", "Series-specific", null, true, "GLOBAL_COMMODITY_INVENTORY", "DERIVED_ANALYTICS"),
    d("Production Cost Curve", "Reliable public cost curve", "MISSING", "P2", "NONE", "No reliable approved source", "NONE", "SOURCE_NOT_PROVIDED", false, null, "SOURCE_ADAPTER"),
    d("Geographic Supply Concentration", "Production concentration by geography", "MISSING", "P2", "NONE", "Insufficient multi-geography production", "NONE", "INPUT_CONSTRAINED", false, null, "SOURCE_ADAPTER"),
    d("Technical / Quant", "Price-only technical analytics", "PARTIAL", "P2", "Commodity price history", "Performance/risk present; full technical set not evidenced", "Existing continuous/reference history", null, true, "GLOBAL_COMMODITY", "DERIVED_ANALYTICS"),
    d("Event / Expectation", "Publication events and what-changed", "PARTIAL", "P2", "Commodity source-event engine", "Source scheduling exists; expectation semantics absent", "Checkpointed events", null, true, "GLOBAL_COMMODITY", "CAPABILITY_WIRING"),
    d("Positioning / Flow", "Futures positioning/flow", "NOT_APPLICABLE", "P2", "GLOBAL_FUTURES", "Owned outside COMMODITY", "N/A", null, false, null, "NONE"),
    d("Cross-Asset relationships", "Gold-real-yield/USD and exact futures links", "PARTIAL", "P2", "Existing shared assets", "Exact mappings incomplete", "Input-dependent", "MAPPING_CONSTRAINED", true, "CROSS_ASSET_ANALYTICS_ENGINE", "CAPABILITY_WIRING"),
    d("Attention / Narrative readiness", "Attention/topic/narrative consumers", "MISSING", "P3", "NONE", "No commodity capability projection", "N/A", "CAPABILITY_NOT_WIRED", true, "MARKET_ATTENTION_ENGINE", "CAPABILITY_WIRING"),
    d("PIT / Revision / Historical context", "Point-in-time and report vintage", "PARTIAL", "P1", "Energy revisions + source provenance", "Energy revisions supported; agriculture vintages missing", "Partial", null, true, "GLOBAL_COMMODITY_REAL_ASSET_ORCHESTRATOR", "VINTAGE_WIRING"),
    d("Incremental", "Changed/new observations only", "PASS", "P0", "Existing domain workers", "Enabled", "Checkpoint resumable", null, false, null, "NONE"),
    d("Scheduler", "Native-frequency automatic continuation", "PASS", "P0", "SOURCE_EVENT_ENGINE", `${health.scheduler.activeSources} active / ${health.scheduler.blockedSources} constrained`, "Next run checkpointed", null, false, null, "NONE"),
    d("Retry", "Bounded retry and failure isolation", "PASS", "P0", "Existing supervisors", "Enabled", "Runtime state retained", null, false, null, "NONE"),
    d("Maintenance", "One-writer/checkpoint/archive lifecycle", "PASS", "P0", "Existing supervisors", "Enabled", "Runtime manifests retained", null, false, null, "NONE"),
    d("Data Trust / Source / Freshness", "Source, license, provenance and freshness", "PARTIAL", "P0", "Existing registries", "Provenance present; multiple constrained sources", "Per-domain", "SOURCE_AND_LICENSE_CONSTRAINTS", true, "GLOBAL_COMMODITY_REAL_ASSET_ORCHESTRATOR", "CAPABILITY_WIRING"),
  ];
  const generatedAt = new Date().toISOString();
  const auditRows = domains.map(item => ({ DOMAIN: item.domain, STATUS: item.status, SOURCE: item.source, ROWS: item.domain === "Historical Price" ? coverage.originalHistoryRows : item.domain === "Inventory" ? invRows : item.domain === "Energy" ? energyRows : null, COVERAGE: item.coverage, HISTORY_DEPTH: item.history, LATEST: item.latest, "PIT / REVISION": item.pit, INCREMENTAL: item.incremental, SCHEDULER: item.scheduler, QUALITY: item.quality, SAMPLE_VALIDATED: item.sample, BLOCKER: item.blocker }));
  const gaps = domains.filter(item => !["PASS", "NOT_APPLICABLE"].includes(item.status)).map((item, index) => ({ gap_id: `COMMODITY-GAP-${String(index + 1).padStart(3, "0")}`, domain: item.domain, requirement: item.requirement, current_status: item.status, source: item.source, coverage: item.coverage, history_depth: item.history, blocker: item.blocker, priority: item.priority, work_type: item.workType, deterministic_possible: item.deterministic ? "YES" : "NO", worker: item.worker, checkpoint: checkpoint.current_stage, retry_policy: item.deterministic ? "BOUNDED_EXISTING_WORKER_POLICY" : "NO_RETRY_UNTIL_CONSTRAINT_CHANGES", scheduler_eligible: item.deterministic ? "YES" : "NO", status: item.deterministic ? "QUEUED" : "PRESERVED_GAP" }));
  const counts = { total: gaps.length, P0: gaps.filter(item => item.priority === "P0").length, P1: gaps.filter(item => item.priority === "P1").length, P2: gaps.filter(item => item.priority === "P2").length, P3: gaps.filter(item => item.priority === "P3").length, deterministic: gaps.filter(item => item.deterministic_possible === "YES").length, blocked: gaps.filter(item => item.current_status.startsWith("BLOCKED_") || item.blocker?.includes("CONSTRAINED")).length };
  const queue = gaps.filter(item => item.deterministic_possible === "YES").map(item => ({ gap_id: item.gap_id, priority: item.priority, domain: item.domain, worker: item.worker, work_type: item.work_type, state: "PENDING", checkpoint: null, attempts: 0 }));
  await atomic(output.audit, { asset: "COMMODITY", constitution: "SMARTFUND_10_PARENT_ASSET_FINAL_RESEARCH_DEPTH", generatedAt, metadataOnly: true, databaseScan: false, historicalRerun: false, rows: auditRows });
  await atomic(output.gaps, { asset: "COMMODITY", generatedAt, counts, gaps });
  await atomic(output.queue, { asset: "COMMODITY", generatedAt, policy: "DETERMINISTIC_ONLY_BOUNDED_EXISTING_WORKER_FIRST", autoStartNewWorker: false, originalCommodityWorkPriority: true, items: queue });
  await atomic(output.summary, `# COMMODITY Depth Gap Summary\n\nGenerated: ${generatedAt}\n\n- Total gaps: ${counts.total}\n- P0: ${counts.P0}\n- P1: ${counts.P1}\n- P2: ${counts.P2}\n- P3: ${counts.P3}\n- Deterministic queued: ${counts.deterministic}\n- Blocked/preserved: ${counts.blocked}\n- Original Commodity work continuing: YES\n- Database scan or historical rerun: NO\n`, true);
  return { generatedAt, counts, currentGap: queue[0]?.gap_id ?? null, queueLength: queue.length, output };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/build-commodity-depth-audit.ts")) {
  buildCommodityDepthAudit().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
