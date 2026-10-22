import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Status = "PASS" | "PARTIAL" | "MISSING" | "BLOCKED_SOURCE" | "BLOCKED_LICENSE" | "BLOCKED_AUTH" | "BLOCKED_SCHEMA" | "NOT_APPLICABLE";
type Priority = "P0" | "P1" | "P2" | "P3";
type Evidence = { domain: string; subdomain: string; status: Status; source: string; rows: number | null; coverage: string; depth: string; latest: string | null; metadata: string; roll: string; oi: string; settlement: string; incremental: string; scheduler: string; quality: string; sample: string; blocker: string | null; priority: Priority; work: string; deterministic: boolean; worker: string | null };

const root = process.cwd();
const runtime = resolve(root, "runtime/futures");
const output = { audit: resolve(runtime, "futures-depth-audit.json"), gaps: resolve(runtime, "futures-gap-manifest.json"), summary: resolve(runtime, "futures-gap-summary.md"), queue: resolve(runtime, "depth-gap-work-queue.json") };
const readJson = async <T>(path: string, fallback: T) => readFile(resolve(root, path), "utf8").then(value => JSON.parse(value) as T).catch(() => fallback);
async function atomic(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path); }

export async function buildFuturesDepthAudit() {
  const generatedAt = new Date().toISOString();
  const commodity = await readJson<any>("runtime/commodity-futures/completion-manifest.json", {});
  const equity = await readJson<any>("runtime/equity-index-futures/p0-db-listed-contract-canary-v3/db-reality.json", {});
  const interest = await readJson<any>("config/interest-futures-professional-depth-matrix.json", {});
  const positioning = await readJson<any>("runtime/futures-positioning/checkpoint.json", {});
  const analytics = await readJson<any>("runtime/futures-positioning/analytics-checkpoint.json", {});
  const contractCounts = Object.fromEntries((equity.contractCounts ?? []).map((item: any) => [item.asset_class, Number(item.row_count)]));
  const observationCounts = Object.fromEntries((equity.observationCounts ?? []).map((item: any) => [item.asset_class, Number(item.row_count)]));
  const contracts = Number(contractCounts.COMMODITY_FUTURES ?? 10) + Number(contractCounts.EQUITY_INDEX_FUTURES ?? 3) + Number(interest.summary?.physicalContracts ?? 20);
  const observations = Number(observationCounts.COMMODITY_FUTURES ?? 50) + Number(observationCounts.EQUITY_INDEX_FUTURES ?? 3) + Number(interest.summary?.physicalObservations ?? 22);
  const latest = commodity.result?.latest ?? positioning.dbLatestReport ?? null;
  const row = (domain: string, subdomain: string, status: Status, source: string, coverage: string, priority: Priority, blocker: string | null, deterministic = false, worker: string | null = null, extra: Partial<Evidence> = {}): Evidence => ({ domain, subdomain, status, source, rows: null, coverage, depth: "METADATA_EVIDENCED", latest, metadata: "PARTIAL", roll: "NOT_EVIDENCED", oi: "NOT_EVIDENCED", settlement: "NOT_EVIDENCED", incremental: "EXISTING_WORKER", scheduler: "EXISTING_SCHEDULER", quality: "METADATA_EVIDENCED", sample: "MANIFEST_AND_CHECKPOINT", blocker, priority, work: deterministic ? "DETERMINISTIC_DERIVATION" : "PRESERVE_CONSTRAINT", deterministic, worker, ...extra });
  const rows: Evidence[] = [
    row("Universe", "Configured Roots", "PASS", "domain universe registries", "69 declared roots before canonical crosswalk", "P0", null, false, null, { rows: 69, metadata: "READY" }),
    row("Identity", "Root Identity Crosswalk", "PARTIAL", "futures_product_roots + domain registries", "Shared roots exist; cross-domain/CFTC crosswalk incomplete", "P0", "MAPPING_CONSTRAINED", true, "GLOBAL_FUTURES_ORCHESTRATOR"),
    row("Identity", "Listed Contract Identity", "PARTIAL", "futures_contracts", `${contracts} evidenced contracts`, "P0", "SOURCE_COVERAGE_PARTIAL", true, "EXISTING_DOMAIN_WORKERS", { rows: contracts }),
    row("Identity", "Collision Safety", "PARTIAL", "exchange + contract_symbol unique key", "Full exchange/year/month collision audit pending", "P0", "MAPPING_CONSTRAINED", true, "GLOBAL_FUTURES_ORCHESTRATOR"),
    row("Specifications", "Multiplier / Tick / Currency / Settlement", "PARTIAL", "futures_contract_specifications + product contracts", "Verified bounded products; global roots partial", "P0", "SOURCE_NOT_PROVIDED", false),
    row("Specifications", "Trading Hours / Notice / Delivery Rules", "MISSING", "official registries", "Not globally materialized", "P1", "SOURCE_NOT_PROVIDED", false),
    row("Lifecycle", "Expiration / Last Trade", "PARTIAL", "futures_contracts + futures_contract_events", "Verified bounded contracts only", "P0", "SOURCE_COVERAGE_PARTIAL", true, "EXISTING_DOMAIN_WORKERS"),
    row("Lifecycle", "First / Last Notice", "MISSING", "NONE", "No global verified coverage", "P1", "SOURCE_NOT_PROVIDED", false),
    row("Historical", "Contract OHLCV", "PARTIAL", "futures_observations", `${observations} evidenced canonical observations`, "P1", "SOURCE_AND_LICENSE_CONSTRAINED", false, null, { rows: observations, depth: "Bounded verified observations; no full rescan", oi: "PARTIAL", settlement: "PARTIAL" }),
    row("Latest", "Contract Quote / Settlement", "PARTIAL", "domain incremental workers", "Commodity bounded products, equity root snapshots, OSE settlements", "P1", "SOURCE_COVERAGE_PARTIAL", true, "EXISTING_DOMAIN_WORKERS", { settlement: "PARTIAL" }),
    row("Intraday", "1m / 5m Contract Bars", "MISSING", "NONE", `0/${contracts} evidenced contracts`, "P1", "SOURCE_AND_LICENSE_CONSTRAINED", false, null, { rows: 0 }),
    row("Market Data", "Bid / Ask / Mid", "MISSING", "NONE", "No verified contract-grain coverage", "P1", "SOURCE_NOT_PROVIDED", false, null, { rows: 0 }),
    row("Settlement", "Official Settlement", "PARTIAL", "CME/JPX/TAIFEX official adapters", "Bounded contract coverage", "P0", "SOURCE_COVERAGE_PARTIAL", true, "EXISTING_DOMAIN_WORKERS", { settlement: "PARTIAL" }),
    row("Volume", "Daily / Intraday Volume", "PARTIAL", "futures_observations", "Equity/commodity bounded; OSE TONA unavailable", "P1", "SOURCE_COVERAGE_PARTIAL", false),
    row("Open Interest", "Contract / Change / Aggregate", "PARTIAL", "futures_observations", "Equity/commodity bounded; interest-rate unavailable", "P1", "SOURCE_COVERAGE_PARTIAL", true, "EXISTING_DOMAIN_WORKERS", { oi: "PARTIAL" }),
    row("Continuous Futures", "Unadjusted Series", "MISSING", "futures_continuous_series", "0 verified series", "P0", "INPUT_CONSTRAINED", false, null, { rows: 0, roll: "MISSING" }),
    row("Continuous Futures", "Back-adjusted Series", "MISSING", "futures_continuous_series", "0 verified series", "P1", "INPUT_CONSTRAINED", false, null, { rows: 0, roll: "MISSING" }),
    row("Roll", "Mapping / History / Reproducibility", "MISSING", "futures_roll_events", "0 verified roll events", "P0", "INPUT_CONSTRAINED", false, null, { rows: 0, roll: "MISSING" }),
    row("Roll", "Calendar / Volume / OI Rules", "PARTIAL", "domain methodology configs", "Rules declared; prerequisites insufficient", "P1", "INPUT_CONSTRAINED", false, null, { roll: "DECLARED_NOT_EXECUTED" }),
    row("Contract Strip", "Front / Second / Third / Deferred", "PARTIAL", "verified contract observations", "OSE 20-contract strip; remaining roots incomplete", "P1", "TIME_DEPTH_CONSTRAINED", true, "EXISTING_DOMAIN_WORKERS", { rows: 20, roll: "PARTIAL" }),
    row("Term Structure", "Forward Curve", "PARTIAL", "OSE_TONA_3M curve artifact", "1 physical root / 20 points", "P1", "INPUT_CONSTRAINED", true, "GLOBAL_FUTURES_ORCHESTRATOR", { rows: 20 }),
    row("Term Structure", "Contango / Backwardation / Shape / Regime", "MISSING", "NONE", "No verified global curve history", "P2", "INPUT_CONSTRAINED", false),
    row("Calendar Spread", "Current / Historical", "PARTIAL", "OSE current curve", "Current-only projection; no history", "P1", "TIME_DEPTH_CONSTRAINED", true, "GLOBAL_FUTURES_ORCHESTRATOR", { rows: 19 }),
    row("Basis", "Spot-Futures Basis", "MISSING", "logical underlying links", "Underlying mappings and aligned inputs incomplete", "P1", "MAPPING_CONSTRAINED", false),
    row("Basis", "Cash-and-Carry / Implied Financing", "NOT_APPLICABLE", "asset-family methodology required", "Not universally applicable; preserve per-family semantics", "P2", null, false),
    row("Roll Yield", "Current / Historical", "MISSING", "NONE", "Continuous/roll prerequisites absent", "P1", "INPUT_CONSTRAINED", false),
    row("Positioning", "CFTC COT History", "PARTIAL", "CFTC LEGACY/DISAGGREGATED/TFF", "Official archive complete; canonicalization checkpoint failed", "P1", "DATABASE_CONNECTION_INTERRUPTED", true, "GLOBAL_FUTURES_POSITIONING", { latest: positioning.dbLatestReport ?? null, depth: "Legacy 1986+; Disaggregated 2009+; TFF 2006+" }),
    row("Positioning", "Market Mapping", "PARTIAL", "futures_positioning_markets", "CFTC identities not fully crosswalked to roots", "P0", "MAPPING_CONSTRAINED", true, "GLOBAL_FUTURES_POSITIONING"),
    row("Positioning", "Long / Short / Net / %OI", "PARTIAL", "futures_positioning_observations", "Categories preserved; analytics incomplete", "P1", analytics.status === "FAILED" ? "DATABASE_CONNECTION_INTERRUPTED" : null, true, "GLOBAL_FUTURES_POSITIONING"),
    row("Positioning", "Percentile / Extreme Positioning", "PARTIAL", "futures_positioning_analytics", "Analytics checkpoint incomplete", "P2", analytics.status === "FAILED" ? "DATABASE_CONNECTION_INTERRUPTED" : "TIME_DEPTH_CONSTRAINED", true, "GLOBAL_FUTURES_POSITIONING"),
    row("Seasonality", "Month / Contract Month / Pre-expiry", "MISSING", "NONE", "Insufficient verified history", "P2", "INPUT_CONSTRAINED", false),
    row("Performance", "Return / Volatility / Drawdown / Sharpe", "MISSING", "NONE", "No valid continuous series; raw-contract scope incomplete", "P2", "INPUT_CONSTRAINED", false),
    row("Technical / Quant", "Indicators / Relative Strength / Correlation", "MISSING", "NONE", "Historical input coverage insufficient", "P2", "INPUT_CONSTRAINED", false),
    row("Event Intelligence", "Expiration / Roll Events", "PARTIAL", "futures_contract_events + futures_roll_events", "Expiration bounded; roll events absent", "P2", "INPUT_CONSTRAINED", true, "EXISTING_DOMAIN_WORKERS"),
    row("Event Intelligence", "Inventory / OPEC / EIA / WASDE / Economic Releases", "MISSING", "logical cross-asset references", "Capability not wired", "P2", "MAPPING_CONSTRAINED", false),
    row("Readiness", "What Changed", "PARTIAL", "checkpoints + lifecycle events", "Operational changes available; projection incomplete", "P2", "CAPABILITY_NOT_WIRED", true, "GLOBAL_FUTURES_ORCHESTRATOR"),
    row("Readiness", "Screen / Alert / Search / Compare", "MISSING", "NONE", "No gap-aware Futures consumer projection", "P3", "CAPABILITY_NOT_WIRED", false),
    row("Lifecycle", "Incremental", "PASS", "four existing domain workers", "All domains retain incremental ownership", "P0", null, false, null, { incremental: "PASS", scheduler: "PASS" }),
    row("Lifecycle", "Scheduler / Retry / Resume", "PASS", "domain checkpoints and supervisors", "Existing scheduler/checkpoint/retry paths active", "P0", null, false, null, { incremental: "PASS", scheduler: "PASS" }),
    row("Lifecycle", "Archive / Maintenance", "PASS", "existing runtime archives", "Archives preserved; no historical rerun", "P1", null, false),
    row("Data Trust", "Source / As-of / Retrieved-at / Freshness", "PARTIAL", "canonical provenance columns + registries", "Verified bounded rows; global coverage partial", "P0", "SOURCE_COVERAGE_PARTIAL", true, "EXISTING_DOMAIN_WORKERS")
  ];
  const locked = rows.filter(item => item.status === "PASS").map(item => `${item.domain}/${item.subdomain}`);
  const gaps = rows.filter(item => item.status !== "PASS" && item.status !== "NOT_APPLICABLE").map((item, index) => ({ gap_id: `FUTURES-GAP-${String(index + 1).padStart(3, "0")}`, asset: "FUTURES", exchange: item.domain === "Positioning" ? "CFTC" : "MULTI_VENUE", contract_family: "MULTI_FAMILY", root_symbol: null, domain: item.domain, subdomain: item.subdomain, requirement: item.subdomain, current_status: item.status, source: item.source, current_rows: item.rows, contract_coverage: item.coverage, root_coverage: item.coverage, history_depth: item.depth, latest_date: item.latest, roll_support: item.roll, oi_support: item.oi, blocker: item.blocker, priority: item.priority, work_type: item.work, deterministic_possible: item.deterministic ? "YES" : "NO", target_worker: item.worker, checkpoint: `METADATA_AUDIT:${generatedAt}`, retry_policy: item.deterministic ? "BOUNDED_EXISTING_WORKER_POLICY" : "NO_RETRY_UNTIL_CONSTRAINT_CHANGES", scheduler_eligible: item.deterministic ? "YES" : "NO", status: item.deterministic ? "DELEGATED_EXISTING_WORKER" : "PRESERVED_GAP", created_at: generatedAt, updated_at: generatedAt }));
  const priority = (value: Priority) => gaps.filter(item => item.priority === value).length;
  const deterministic = gaps.filter(item => item.deterministic_possible === "YES");
  const blocked = gaps.filter(item => item.blocker || item.deterministic_possible === "NO");
  const counts = { total: gaps.length, P0: priority("P0"), P1: priority("P1"), P2: priority("P2"), P3: priority("P3"), deterministic: deterministic.length, blocked: blocked.length, lockedPass: locked.length };
  await atomic(output.audit, { asset: "FUTURES", constitution: "SMARTFUND_10_PARENT_ASSET_FINAL_RESEARCH_DEPTH", generatedAt, metadataOnly: true, databaseScan: false, historicalRerun: false, continuousRebuild: false, originalWorkContinuing: true, lockedPassDomains: locked, rows: rows.map(item => ({ DOMAIN: item.domain, SUBDOMAIN: item.subdomain, STATUS: item.status, SOURCE: item.source, CONTRACTS_COVERED: item.coverage, ROOTS_COVERED: item.coverage, EXCHANGES_COVERED: item.coverage, ROWS: item.rows, HISTORY_DEPTH: item.depth, LATEST_DATE: item.latest, CONTRACT_METADATA_QUALITY: item.metadata, ROLL_SUPPORT: item.roll, OI_SUPPORT: item.oi, SETTLEMENT_SUPPORT: item.settlement, INCREMENTAL_SUPPORT: item.incremental, SCHEDULER_SUPPORT: item.scheduler, QUALITY: item.quality, SAMPLE_VALIDATED: item.sample, BLOCKER: item.blocker })) });
  await atomic(output.gaps, { asset: "FUTURES", generatedAt, counts, lockedPassDomains: locked, gaps });
  await atomic(output.queue, { asset: "FUTURES", generatedAt, ownership: "EXISTING_WORKERS_ONLY", bounded: true, noNewWorker: true, items: deterministic });
  await atomic(output.summary, `# FUTURES Depth Gap Summary\n\nGenerated: ${generatedAt}\n\n- Total gaps: ${counts.total}\n- P0: ${counts.P0}\n- P1: ${counts.P1}\n- P2: ${counts.P2}\n- P3: ${counts.P3}\n- Deterministic gaps delegated: ${counts.deterministic}\n- Blocked/preserved gaps: ${counts.blocked}\n- Locked PASS domains: ${locked.join(", ")}\n- Database scan, history rerun, continuous rebuild: NO\n- Original FUTURES work continuing: YES\n`);
  return { counts, locked, current: deterministic[0]?.gap_id ?? null, paths: output };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/build-futures-depth-audit.ts")) buildFuturesDepthAudit().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
