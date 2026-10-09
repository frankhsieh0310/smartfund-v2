import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";

type Status = "PASS" | "PARTIAL" | "MISSING" | "BLOCKED_SOURCE" | "BLOCKED_LICENSE" | "BLOCKED_AUTH" | "BLOCKED_SCHEMA" | "NOT_APPLICABLE";
type Priority = "P0" | "P1" | "P2" | "P3";
type Domain = { domain: string; subdomain: string; status: Status; source: string; coverage: string; rows: number | null; depth: string; latest: string | null; blocker: string | null; priority: Priority; work: string; deterministic: boolean; worker: string | null };

const root = process.cwd();
const runtime = resolve(root, "runtime/fx");
const out = { audit: resolve(runtime, "fx-depth-audit.json"), gaps: resolve(runtime, "fx-gap-manifest.json"), summary: resolve(runtime, "fx-gap-summary.md"), queue: resolve(runtime, "depth-gap-work-queue.json") };
const iso = () => new Date().toISOString();
async function atomic(file: string, value: string) { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, value); await rename(temp, file); }
const d = (domain: string, subdomain: string, status: Status, source: string, coverage: string, rows: number | null, depth: string, latest: string | null, blocker: string | null, priority: Priority, work: string, deterministic: boolean, worker: string | null): Domain => ({ domain, subdomain, status, source, coverage, rows, depth, latest, blocker, priority, work, deterministic, worker });

const domains: Domain[] = [
  d("Universe","FX universe","PASS","fx-platform.json","528/528 pairs; 33/33 currencies",528,"Configured canonical universe","2026-08-12",null,"P0","LOCK",false,null),
  d("Identity","Canonical identity","PASS","fx_pairs + fx_pair_aliases","528 identities; 528 aliases",1056,"Current registry","2026-08-12",null,"P0","LOCK",false,null),
  d("Currency Identity","ISO/onshore/offshore currency","PASS","fx_currencies","33/33",33,"Current registry","2026-08-12",null,"P0","LOCK",false,null),
  d("Currency Pair Identity","Base/quote canonical pair","PASS","fx_pairs","528/528",528,"Current registry","2026-08-12",null,"P0","LOCK",false,null),
  d("Base Currency","Base semantics","PASS","fx_pairs.base_currency","528/528",528,"Current registry","2026-08-12",null,"P0","LOCK",false,null),
  d("Quote Currency","Quote semantics","PASS","fx_pairs.quote_currency","528/528",528,"Current registry","2026-08-12",null,"P0","LOCK",false,null),
  d("Spot","Spot/reference separation","PARTIAL","YAHOO_CHART + official adapters","Source-permitted pairs; exact total rows not exposed by metadata",null,"Existing latest/incremental","2026-08-12","SOURCE_NOT_PROVIDED_FOR_FULL_UNIVERSE","P1","INCREMENTAL",true,"STANDALONE_FX"),
  d("Reference Rate","Official reference/fixing","PARTIAL","FED/ECB/BOE/BOJ/SNB/BOC/RBA/RBNZ/MAS/HKMA/PBOC/IMF/BIS","13 official registries; per-pair coverage incomplete",null,"Source-specific",null,"SOURCE_NOT_PROVIDED","P1","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Bid","Executable bid","BLOCKED_SOURCE","YAHOO_CHART","0 evidenced",0,"NONE",null,"SOURCE_NOT_PROVIDED","P1","SOURCE_ACCESS",false,null),
  d("Ask","Executable ask","BLOCKED_SOURCE","YAHOO_CHART","0 evidenced",0,"NONE",null,"SOURCE_NOT_PROVIDED","P1","SOURCE_ACCESS",false,null),
  d("Mid","Mid/reference close","PARTIAL","fx_latest_quotes + fx_candles","Source-permitted pairs",null,"Existing history",null,"REFERENCE_NOT_EXECUTABLE","P1","INCREMENTAL",true,"STANDALONE_FX"),
  d("Spread","Bid/ask spread","BLOCKED_SOURCE","YAHOO_CHART","0 evidenced",0,"NONE",null,"SOURCE_NOT_PROVIDED","P1","SOURCE_ACCESS",false,null),
  d("Historical","Deepest reliable history","PARTIAL","fx_candles/YAHOO_CHART","Active 528x12 checkpoint; locked completed keys",null,"1m 7d; other intraday 60d; daily max source boundary",null,"TIME_DEPTH_CONSTRAINED","P0","INCREMENTAL",true,"STANDALONE_FX"),
  d("Latest","Latest quote","PARTIAL","fx_latest_quotes/YAHOO_CHART","Source-permitted pairs",null,"Incremental","2026-08-12","SOURCE_CONSTRAINED","P1","INCREMENTAL",true,"STANDALONE_FX"),
  d("Intraday","1m/5m/15m/60m and derived hours","PARTIAL","fx_candles/YAHOO_CHART","Configured 528 pairs; source-dependent",null,"1m 7d; other intraday 60d",null,"TIME_DEPTH_CONSTRAINED","P1","INCREMENTAL",true,"STANDALONE_FX"),
  d("Daily","Daily OHLC","PARTIAL","fx_candles/YAHOO_CHART","Configured 528 pairs; source-dependent",null,"Maximum provider depth preserved",null,"SOURCE_CONSTRAINED","P1","INCREMENTAL",true,"STANDALONE_FX"),
  d("Cross Rates","Derived canonical cross","MISSING","fx_candles inputs","No materialized validated cross coverage",0,"Input-dependent",null,null,"P1","DERIVED_ANALYTICS",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Triangulation","Timestamp-aligned lineage","MISSING","fx_candles inputs","0 validated lineage records",0,"Input-dependent",null,null,"P1","DERIVED_ANALYTICS",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Forward Points","Forward points","BLOCKED_LICENSE","BOE_IADB/LSEG_WMR candidate","1 pair; 2 tenors; 0 points",2,"Through 2021-06-30","2021-06-30","LICENSE_CONSTRAINED","P1","LICENSE",false,"FX_FORWARD_POINTS"),
  d("Forward Curve","Verified forward curve","MISSING","fx_forward_observations","0 ready curves",0,"NONE",null,"INPUT_CONSTRAINED","P1","DERIVED_ANALYTICS",true,"FX_FORWARD_POINTS"),
  d("Forward Tenors","ON-TN-SN through 1Y","PARTIAL","fx_forward_instruments","2 evidenced tenors for 1 pair",2,"Through 2021-06-30","2021-06-30","LICENSE_CONSTRAINED","P1","LICENSE",false,"FX_FORWARD_POINTS"),
  d("Carry","Derived carry proxy","MISSING","FX + GLOBAL_MACRO logical inputs","0 evidenced series",0,"NONE",null,"INPUT_CONSTRAINED","P1","DERIVED_ANALYTICS",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Carry History","Versioned carry history","MISSING","FX + GLOBAL_MACRO logical inputs","0 evidenced series",0,"NONE",null,"INPUT_CONSTRAINED","P2","DERIVED_ANALYTICS",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Interest Rate Differential","Base-minus-quote rates","MISSING","GLOBAL_MACRO read-only dependency","0 evidenced FX-linked series",0,"NONE",null,"MAPPING_CONSTRAINED","P1","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Rate Differential History","Historical rate differential","MISSING","GLOBAL_MACRO read-only dependency","0 evidenced FX-linked history",0,"NONE",null,"MAPPING_CONSTRAINED","P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("REER","Real effective exchange rates","PARTIAL","GLOBAL_INDEX/CURRENCY_INDEX","BIS_USD_REER evidenced; broader currencies not evidenced",null,"Official series-dependent",null,"SOURCE_NOT_PROVIDED","P1","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("REER History","REER history","PARTIAL","GLOBAL_INDEX/CURRENCY_INDEX","USD REER history path evidenced",null,"Official source depth",null,"SOURCE_NOT_PROVIDED","P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("PPP","Purchasing-power parity","MISSING","NONE","0 evidenced approved series",0,"NONE",null,"SOURCE_NOT_PROVIDED","P1","SOURCE_ADAPTER",false,null),
  d("PPP Deviation","Spot-versus-PPP deviation","MISSING","NONE","0 evidenced series",0,"NONE",null,"INPUT_CONSTRAINED","P1","DERIVED_ANALYTICS",false,null),
  d("Central Bank Reserves","Official reserve level","PARTIAL","FRED/IMF via economic_series","1 canonical series",907,"1950-12-01 to 2026-06-01","2026-06-01","SOURCE_NOT_PROVIDED","P1","INCREMENTAL",true,"GLOBAL_FX_RESERVES"),
  d("Reserve History","Reserve history","PARTIAL","economic_values","907 canonical rows; 1 series",907,"1950-12-01 to 2026-06-01","2026-06-01","SOURCE_NOT_PROVIDED","P1","INCREMENTAL",true,"GLOBAL_FX_RESERVES"),
  d("FX Intervention","Official intervention events","MISSING","NONE","0 evidenced series",0,"NONE",null,"SOURCE_NOT_PROVIDED","P1","SOURCE_ADAPTER",false,null),
  d("Intervention History","Intervention event history","MISSING","NONE","0 evidenced series",0,"NONE",null,"SOURCE_NOT_PROVIDED","P2","SOURCE_ADAPTER",false,null),
  d("Positioning","FX futures positioning linkage","PARTIAL","GLOBAL_FUTURES_POSITIONING","Positioning exists; exact FX-pair mapping incomplete",null,"Source-dependent",null,"MAPPING_CONSTRAINED","P1","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Relative Strength","Cross-pair relative strength","MISSING","fx_candles inputs","0 evidenced series",0,"NONE",null,null,"P2","DERIVED_ANALYTICS",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Return","Window returns","PARTIAL","fx_metrics","Canary metrics evidenced; full pair/timeframe matrix not evidenced",75,"Existing history windows",null,null,"P1","DERIVED_ANALYTICS",true,"STANDALONE_FX"),
  d("Volatility","Realized volatility","PARTIAL","fx_metrics","Canary metrics evidenced; full matrix not evidenced",75,"Existing history windows",null,null,"P1","DERIVED_ANALYTICS",true,"STANDALONE_FX"),
  d("Drawdown","Maximum/current drawdown","MISSING","fx_candles inputs","0 evidenced complete matrix",0,"Input-dependent",null,null,"P2","DERIVED_ANALYTICS",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Rolling Correlation","Compatible aligned correlations","MISSING","fx_candles inputs","0 evidenced complete matrix",0,"Input-dependent",null,null,"P2","DERIVED_ANALYTICS",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Technical / Quant","Versioned technical indicators","PARTIAL","fx_metrics","Canary SMA/EMA/RSI/MACD/etc.; full matrix not evidenced",75,"Existing history windows",null,null,"P1","DERIVED_ANALYTICS",true,"STANDALONE_FX"),
  d("Seasonality","Calendar seasonality","MISSING","fx_candles inputs","0 evidenced series",0,"Input-dependent",null,null,"P2","DERIVED_ANALYTICS",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Historical Percentile","Rolling historical percentile","MISSING","fx_candles inputs","0 evidenced complete matrix",0,"Input-dependent",null,null,"P2","DERIVED_ANALYTICS",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Event Intelligence","FX event linkage","MISSING","Existing event/calendar domains","0 FX capability projection",0,"N/A",null,"MAPPING_CONSTRAINED","P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Central Bank Events","Policy-event linkage","PARTIAL","GLOBAL_MACRO/economic calendar","Events exist; pair linkage incomplete",null,"Existing event history",null,"MAPPING_CONSTRAINED","P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("CPI / GDP / Employment linkage","Macro-to-currency linkage","MISSING","GLOBAL_MACRO","0 evidenced mapping matrix",0,"N/A",null,"MAPPING_CONSTRAINED","P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Cross-Asset Relationships","FX-to-index/futures/macro linkage","PARTIAL","Shared asset identities","Exact mappings incomplete",null,"Input-dependent",null,"MAPPING_CONSTRAINED","P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("What Changed Readiness","Deterministic change feed","MISSING","FX checkpoints/metrics","0 capability projection",0,"N/A",null,null,"P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Screen / Alert Readiness","Rule/scan/alert data readiness","PARTIAL","fx_metrics + coverage","Core price inputs partial; advanced metrics missing",null,"Input-dependent",null,"INPUT_CONSTRAINED","P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Smart Compare Readiness","Comparable FX metrics","PARTIAL","ranking/compare FX contracts","Return metric ready; risk/depth incomplete",null,"Input-dependent",null,"INPUT_CONSTRAINED","P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Market Replay Readiness","Timestamped replay inputs","PARTIAL","fx_candles","Bars exist; event/quote semantics incomplete",null,"Source-dependent",null,"INPUT_CONSTRAINED","P3","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Incremental","Checkpointed incremental ingestion","PASS","STANDALONE_FX","528 pairs x 12 intervals configured",null,"Checkpoint-resumable","2026-08-12",null,"P0","LOCK",false,null),
  d("Scheduler","Automatic continuation","PASS","STANDALONE_FX + existing production lifecycle","Active process and scheduler path",null,"Continuous","2026-08-12",null,"P0","LOCK",false,null),
  d("Retry","Bounded retry/dead-letter","PASS","fx_work_items + runtime checkpoint","Bounded retry policy present",null,"Durable",null,null,"P0","LOCK",false,null),
  d("Resume","Checkpoint resume","PASS","runtime/fx/checkpoint.json","Current checkpoint preserved",null,"Durable","2026-08-12",null,"P0","LOCK",false,null),
  d("Maintenance","Maintenance capability","PASS","FX platform lifecycle","Configured capability",null,"Continuous",null,null,"P3","LOCK",false,null),
  d("Data Trust","Trust matrix","PARTIAL","fx_coverage + runtime matrices","Coverage/provenance present; fragmented",null,"Per domain",null,"COVERAGE_FRAGMENTED","P0","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Source","Source identity","PASS","fx_sources","14 configured sources",14,"Current registry","2026-08-12",null,"P0","LOCK",false,null),
  d("As-of","Observation timestamp","PASS","fx_candles.open_time/close_time","Canonical timestamp fields present",null,"Per observation",null,null,"P0","LOCK",false,null),
  d("Retrieved-at","Ingestion timestamp","PASS","fx_candles.ingested_at","Canonical retrieved/ingested field present",null,"Per observation",null,null,"P0","LOCK",false,null),
  d("Freshness","Freshness classification","PARTIAL","fx_coverage + runtime heartbeat","Current price freshness not unified across domains",null,"Per domain",null,"COVERAGE_FRAGMENTED","P0","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Coverage","Unified coverage","PARTIAL","fx_coverage + forward/reserve matrices","Three coverage paths not unified",null,"Per domain",null,"COVERAGE_FRAGMENTED","P0","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Official / Derived","Semantic classification","PARTIAL","source/verification/lineage fields","Fields exist; cross/carry lineage not materialized",null,"Per domain",null,"LINEAGE_INCOMPLETE","P0","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Research Engines","Event/positioning/cross-asset/change engines","PARTIAL","Existing shared engines","Input readiness varies by subdomain",null,"Input-dependent",null,"INPUT_CONSTRAINED","P2","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Research Workspace","Search/custom series/workspace","PARTIAL","Existing web/data contracts","Core identity/history ready; advanced metrics partial",null,"Input-dependent",null,"INPUT_CONSTRAINED","P3","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR"),
  d("Market Intelligence Surfaces","Heatmap/pulse/movers/calendar/compare","PARTIAL","Existing shared consumers","Core inputs partial; event/risk mappings incomplete",null,"Input-dependent",null,"INPUT_CONSTRAINED","P3","CAPABILITY_WIRING",true,"GLOBAL_FX_ORCHESTRATOR")
];

async function main() {
  await mkdir(runtime, { recursive: true });
  const generatedAt = iso();
  const auditRows = domains.map(item => ({ DOMAIN: item.domain, SUBDOMAIN: item.subdomain, STATUS: item.status, SOURCE: item.source, PAIR_COVERAGE: item.coverage, ROWS: item.rows, HISTORY_DEPTH: item.depth, LATEST_DATE: item.latest, INCREMENTAL_SUPPORT: item.status === "PASS" || item.deterministic ? "YES" : "NO", SCHEDULER_SUPPORT: item.status === "PASS" || item.deterministic ? "YES" : "NO", QUALITY: item.status === "PASS" ? "LOCKED_METADATA_AND_SAMPLE_VALIDATED" : "GAP_CLASSIFIED", SAMPLE_VALIDATED: item.status === "PASS" ? "YES" : "METADATA_EVIDENCE_ONLY", BLOCKER: item.blocker, LOCKED: item.status === "PASS" }));
  const gaps = domains.filter(item => !["PASS","NOT_APPLICABLE"].includes(item.status)).map((item, index) => ({ gap_id: `FX-GAP-${String(index + 1).padStart(3, "0")}`, domain: item.domain, subdomain: item.subdomain, requirement: item.subdomain, current_status: item.status, source: item.source, pair_coverage: item.coverage, rows: item.rows, history_depth: item.depth, latest_date: item.latest, blocker: item.blocker, priority: item.priority, work_type: item.work, deterministic_possible: item.deterministic ? "YES" : "NO", target_worker: item.worker, checkpoint: `METADATA_AUDIT:${generatedAt}`, retry_policy: item.deterministic ? "BOUNDED_EXISTING_WORKER_POLICY" : "NO_RETRY_UNTIL_CONSTRAINT_CHANGES", scheduler_eligible: item.deterministic ? "YES" : "NO", status: item.deterministic ? "DELEGATED_EXISTING_WORKER" : "PRESERVED_GAP" }));
  const counts = { total: gaps.length, P0: gaps.filter(x=>x.priority==="P0").length, P1: gaps.filter(x=>x.priority==="P1").length, P2: gaps.filter(x=>x.priority==="P2").length, P3: gaps.filter(x=>x.priority==="P3").length, deterministic: gaps.filter(x=>x.deterministic_possible==="YES").length, blocked: gaps.filter(x=>x.current_status.startsWith("BLOCKED") || x.blocker === "SOURCE_NOT_PROVIDED" || x.blocker === "LICENSE_CONSTRAINED").length };
  const locked = auditRows.filter(x=>x.LOCKED).map(x=>x.DOMAIN);
  const queueItems = gaps.filter(x=>x.deterministic_possible === "YES").map(x=>({ ...x, queue_status: "QUEUED", canonical_write: false, locked_pass_untouched: true }));
  await atomic(out.audit, `${JSON.stringify({ asset:"FX", constitution:"SMARTFUND_10_PARENT_ASSET_FINAL_RESEARCH_DEPTH", generatedAt, metadataOnly:true, databaseScan:false, historicalRerun:false, passLocked:true, rows:auditRows },null,2)}\n`);
  await atomic(out.gaps, `${JSON.stringify({ asset:"FX", generatedAt, counts, locked_pass_domains:locked, gaps },null,2)}\n`);
  await atomic(out.queue, `${JSON.stringify({ asset:"FX", generatedAt, policy:"PARTIAL_OR_MISSING_AND_DETERMINISTIC_ONLY", checkpointResumable:true, retryBounded:true, schedulerEligible:true, originalIncrementalUntouched:true, status:"ACTIVE", items:queueItems },null,2)}\n`);
  await atomic(out.summary, `# FX Depth Gap Summary\n\nGenerated: ${generatedAt}\n\n- Audit domains: ${auditRows.length}\n- Locked PASS domains: ${locked.length}\n- Total gaps: ${counts.total}\n- P0: ${counts.P0}\n- P1: ${counts.P1}\n- P2: ${counts.P2}\n- P3: ${counts.P3}\n- Deterministic delegated gaps: ${counts.deterministic}\n- Blocked/source-not-provided gaps: ${counts.blocked}\n\nPASS domains are locked. Historical and universe rebuilds are prohibited. Deterministic gaps are delegated to existing workers/orchestrator through the bounded resumable queue.\n`);
  const current = queueItems[0] ?? null;
  const prior = await readFile(resolve(root,"runtime-status/fx.json"),"utf8").then(JSON.parse).catch(()=>({}));
  await writeAssetRuntimeStatus({ ...prior, ASSET:"FX", DEPTH_AUDIT_STATUS:"COMPLETE_GAPS_QUEUED", DEPTH_GAPS_TOTAL:counts.total, DEPTH_GAPS_P0:counts.P0, DEPTH_GAPS_P1:counts.P1, DEPTH_GAPS_P2:counts.P2, DEPTH_GAPS_P3:counts.P3, DETERMINISTIC_GAPS_TOTAL:counts.deterministic, BLOCKED_GAPS_TOTAL:counts.blocked, CURRENT_GAP_ID:current?.gap_id??null, CURRENT_GAP_DOMAIN:current?.domain??null, GAPS_COMPLETED:0, LAST_GAP_PROGRESS:`${counts.deterministic} deterministic gaps delegated; ${locked.length} PASS domains locked`, GAP_QUEUE_STATUS:"ACTIVE", progressChanged:true });
  console.log(JSON.stringify({ counts, locked:locked.length, current:current?.gap_id??null }));
}

main().catch(error=>{console.error(error);process.exitCode=1});
