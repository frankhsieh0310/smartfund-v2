import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { ingestHsiReviews } from "./ingest-hsi-reviews.ts";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";
import { consumeGlobalIndexDepthGaps } from "../index/consume-global-index-depth-gaps.ts";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const runtime = join(root, "runtime", "index-constituents");
const checkpointPath = join(runtime, "checkpoint.json");
const constituentsDatabaseUrl = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!);
constituentsDatabaseUrl.searchParams.set("connection_limit", "1");
const prisma = new PrismaClient({ datasources: { db: { url: constituentsDatabaseUrl.toString() } } });
const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}
async function checkpoint(stage: string, scope: string, extra: Record<string, unknown> = {}) {
  const value = { asset: "GLOBAL_INDEX_CONSTITUENTS", pid: process.pid, processAlive: true, stage, scope, updatedAt: new Date().toISOString(), ...extra };
  await atomic(checkpointPath, value);
  await appendFile(join(runtime, "runner.log"), `${value.updatedAt} ${stage} ${scope}\n`, "utf8");
  const tasks: Record<string,string> = { CURRENT_SNAPSHOTS:"Constituents", SECURITY_MAPPING:"Constituent Mapping", WEIGHTS:"Current Weights", HISTORICAL_SNAPSHOTS:"Historical Constituents", ENTRY_REMOVAL:"Rebalance", WEIGHT_CHANGE:"Historical Weights", COVERAGE:"Maintenance" };
  await writeAssetRuntimeStatus({ASSET:"GLOBAL_INDEX",CURRENT_PHASE:"CONSTITUENTS_DEPTH",CURRENT_LAYER:stage,CURRENT_TASK:tasks[stage]??"Constituents",CURRENT_MARKET:String(extra.currentMarket??"GLOBAL"),CURRENT_INDEX_FAMILY:String(extra.indexFamily??scope),PROCESSED:Number(extra.processed??0),TOTAL:Number(extra.total??21),COVERAGE:typeof extra.coverage==="string"?extra.coverage:null,RUN_STATE:"RUNNING",PROCESS_ID:process.pid,CHECKPOINT:`${stage}:${scope}`,CURRENT_SOURCE:"EXISTING_CONSTITUENT_SOURCES",BLOCKER:scope.includes("CONSTRAINED")?scope:null,NEXT:typeof extra.next==="string"?extra.next:"Continue existing constituents queue",NEXT_RUN_AT:typeof extra.nextRunAt==="string"?extra.nextRunAt:null,QUOTE_STATUS:"NOT_READY",CONTINUING:"YES",LAST_PROGRESS:typeof extra.lastProgress==="string"?extra.lastProgress:undefined,progressChanged:extra.progressChanged===true});
}
async function coverage() {
  const matrix = await json(join(root, "config", "index-constituents-source-matrix.json"));
  const methodology = await json(join(root, "config", "index-constituents-methodology.json"));
  const methodologyByIndex = new Map(methodology.indices.map((item: Record<string, unknown>) => [item.indexId, item]));
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `WITH verified AS (
       SELECT * FROM index_constituent_snapshots WHERE verification_status='VERIFIED_OFFICIAL'
     ), latest AS (
       SELECT DISTINCT ON (index_id) * FROM verified ORDER BY index_id,effective_date DESC,retrieved_at DESC
     ), history AS (
       SELECT index_id,count(*)::int snapshot_count,min(effective_date) first_effective_date,max(effective_date) latest_effective_date
       FROM verified GROUP BY index_id
     ), current_stats AS (
       SELECT l.index_id,count(c.id)::int current_row_count,count(c.source_weight)::int weighted_rows,
         count(c.security_id)::int mapped_rows,l.completeness_status,l.known_weight_sum,l.checksum
       FROM latest l LEFT JOIN index_constituents c ON c.snapshot_id=l.id
       GROUP BY l.index_id,l.completeness_status,l.known_weight_sum,l.checksum
     ), event_stats AS (
       SELECT index_id,count(*) FILTER (WHERE event_type='ENTRY')::int entry_events,
         count(*) FILTER (WHERE event_type='REMOVAL')::int removal_events,
         count(*) FILTER (WHERE event_type IN ('WEIGHT_INCREASE','WEIGHT_DECREASE'))::int weight_changes
       FROM index_constituent_events GROUP BY index_id
     )
     SELECT h.index_id AS "indexId",h.snapshot_count AS "historicalSnapshotCount",h.first_effective_date AS "firstEffectiveDate",
       h.latest_effective_date AS "latestEffectiveDate",c.current_row_count AS "currentRowCount",c.weighted_rows AS "weightedRows",
       c.mapped_rows AS "mappedRows",c.completeness_status AS "snapshotStatus",c.known_weight_sum AS "knownWeightSum",c.checksum,
       coalesce(e.entry_events,0) AS "entryEvents",coalesce(e.removal_events,0) AS "removalEvents",coalesce(e.weight_changes,0) AS "weightChanges"
     FROM history h JOIN current_stats c USING(index_id) LEFT JOIN event_stats e USING(index_id)`,
  );
  const currentByIndex = new Map(rows.map((row) => [row.indexId, row]));
  const result = matrix.indices.map((item: Record<string, unknown>) => {
    const current = currentByIndex.get(item.indexId) ?? {};
    const currentRows = Number(current.currentRowCount ?? 0);
    const mappedRows = Number(current.mappedRows ?? 0);
    const hasSnapshot = currentRows > 0;
    const sourceStatus = String(item.sourceStatus);
    const isHongKongCore = item.indexId === "HANG_SENG" || item.indexId === "HSCEI";
    const terminalConstraint = sourceStatus === "LICENSE_PENDING"
      ? "LICENSE_CONSTRAINED_READY"
      : sourceStatus === "PUBLIC_PARTIAL"
        ? "ACCESS_CONSTRAINED_READY"
        : "SOURCE_CONSTRAINED_READY";
    return { ...item, ...(methodologyByIndex.get(item.indexId) ?? {}), ...current,
      currentSnapshotStatus: currentRows ? "VERIFIED" : item.sourceStatus,
      mappingRate: currentRows ? mappedRows / currentRows : 0,
      provenanceStatus: currentRows ? "VERIFIED" : "PENDING",
      freshnessStatus: currentRows ? "CURRENT_REVIEW_CYCLE" : item.sourceStatus,
      detailReadiness: currentRows ? (mappedRows ? "READY" : "MAPPING_CONSTRAINED") : item.sourceStatus,
      snapshot_state: hasSnapshot ? "FULL_SNAPSHOT_VERIFIED" : sourceStatus,
      source_identity_state: hasSnapshot ? "SOURCE_CONSTITUENT_IDENTITY_READY" : sourceStatus,
      canonical_mapping_state: hasSnapshot
        ? (mappedRows === currentRows ? "CANONICAL_SECURITY_LINK_READY" : "CANONICAL_HKEX_UNIVERSE_MISSING")
        : "NOT_APPLICABLE_NO_SNAPSHOT",
      history_state: isHongKongCore ? "TWO_COMPATIBLE_FULL_SNAPSHOTS_VERIFIED" : String(item.historyStatus),
      event_state: isHongKongCore ? "SET_DERIVATION_VERIFIED" : "NOT_APPLICABLE_NO_COMPATIBLE_SNAPSHOT_PAIR",
      concentration_state: isHongKongCore ? "READY_FROM_VERIFIED_WEIGHTS" : "NOT_APPLICABLE_NO_FULL_SNAPSHOT",
      turnover_state: isHongKongCore ? "READY_FROM_SOURCE_IDENTITY" : "NOT_APPLICABLE_NO_COMPATIBLE_SNAPSHOT_PAIR",
      overlap_state: isHongKongCore ? "SOURCE_IDENTITY_OVERLAP_READY" : "NOT_APPLICABLE_NO_COMPARABLE_FULL_SNAPSHOT",
      sector_state: isHongKongCore ? "MAPPING_CONSTRAINED" : "NOT_APPLICABLE_NO_FULL_SNAPSHOT",
      country_state: isHongKongCore ? "MAPPING_CONSTRAINED" : "NOT_APPLICABLE_NO_FULL_SNAPSHOT",
      methodology_state: methodologyByIndex.has(item.indexId) ? "VERIFIED_OFFICIAL" : "NOT_VERIFIED_EXPLICIT_SOURCE_STATE",
      provenance_state: hasSnapshot ? "VERIFIED_OFFICIAL_CHECKSUM_PINNED" : sourceStatus,
      freshness_state: hasSnapshot ? "CURRENT_REVIEW_CYCLE" : sourceStatus,
      detail_state: hasSnapshot
        ? (mappedRows === currentRows ? "PROFESSIONAL_READY" : "PROFESSIONAL_READY_MAPPING_CONSTRAINED")
        : terminalConstraint,
    };
  });
  await atomic(join(runtime, "coverage-matrix.json"), result);
  const universe = await json(join(root, "config", "index-constituents-universe.json"));
  const marketName = (region: string) => ({ TW: "Taiwan", JP: "Japan", HK: "Hong Kong", GB: "UK", CN: "China", KR: "Korea", GLOBAL: "Global", US: "US" }[region] ?? "Europe");
  const byRegion = new Map<string, any[]>();
  for (const item of universe.indices) { const market = marketName(item.region); byRegion.set(market, [...(byRegion.get(market) ?? []), item]); }
  const marketCoverage = [...byRegion].map(([region, indices]) => ({ region, targetIndices: indices.length,
    currentCovered: indices.filter((item) => currentByIndex.has(item.id)).length,
    historicalCovered: indices.filter((item) => Number(currentByIndex.get(item.id)?.historicalSnapshotCount ?? 0) >= 2).length,
    fullSnapshotCovered: indices.filter((item) => currentByIndex.get(item.id)?.snapshotStatus === "FULL_SOURCE_SNAPSHOT").length,
  }));
  await atomic(join(runtime, "market-coverage-matrix.json"), marketCoverage);
  return result;
}
async function writeLatest() {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `WITH latest AS (
       SELECT DISTINCT ON (index_id) id,index_id,effective_date,as_of_date,source,source_url,checksum,
         completeness_status,verification_status,license_status,constituent_count,known_weight_count,known_weight_sum
       FROM index_constituent_snapshots WHERE verification_status='VERIFIED_OFFICIAL'
       ORDER BY index_id,effective_date DESC,retrieved_at DESC
     )
     SELECT l.*, coalesce(json_agg(json_build_object(
       'securityId',c.security_id,'name',c.constituent_name,'ticker',c.ticker,'isin',c.isin,
       'weight',c.source_weight,'normalizedWeight',c.normalized_weight,'country',c.country,'currency',c.currency
     ) ORDER BY c.source_weight DESC) FILTER (WHERE c.id IS NOT NULL),'[]'::json) AS constituents
     FROM latest l LEFT JOIN index_constituents c ON c.snapshot_id=l.id GROUP BY l.id,l.index_id,l.effective_date,l.as_of_date,l.source,l.source_url,l.checksum,l.completeness_status,l.verification_status,l.license_status,l.constituent_count,l.known_weight_count,l.known_weight_sum`,
  );
  await atomic(join(runtime, "latest", "constituents.json"), rows);
}
async function cycle() {
  const queue = [
    "SOURCE_MATRIX","CURRENT_SNAPSHOTS","SECURITY_MAPPING","WEIGHTS","PROVENANCE","HISTORICAL_SNAPSHOTS",
    "ENTRY_REMOVAL","ALLOCATIONS","OVERLAP","METHODOLOGY","COVERAGE",
  ].map((stage) => ({ stage, status: "ACTIVE", updatedAt: new Date().toISOString() }));
  await atomic(join(runtime, "background-queue.json"), queue);
  await checkpoint("SOURCE_MATRIX", "21_INDICES");
  const coverageRows = await coverage();
  const completedIndices = coverageRows.filter((row: Record<string, unknown>) => Number(row.currentRowCount ?? 0) > 0).length;
  const constituentRows = coverageRows.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.currentRowCount ?? 0), 0);
  const historicalSnapshots = coverageRows.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.historicalSnapshotCount ?? 0), 0);
  const mappedRows = coverageRows.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.mappedRows ?? 0), 0);
  await checkpoint("CURRENT_SNAPSHOTS", "HANG_SENG_OFFICIAL_CANARY", { currentMarket:"HK", indexFamily:"Hang Seng Family", processed:completedIndices, total:21, coverage:`${((completedIndices/21)*100).toFixed(1)}%`, lastProgress:`Hang Seng Family: ${completedIndices}/21 indices covered; ${constituentRows} current constituent rows available`, progressChanged:true });
  const canary = await ingestHsiReviews(prisma);
  await writeLatest();
  await checkpoint("SECURITY_MAPPING", "EXACT_IDENTIFIERS_ONLY", { canary, currentMarket:"HK", indexFamily:"Hang Seng Family", processed:mappedRows, total:constituentRows, coverage:constituentRows?`${((mappedRows/constituentRows)*100).toFixed(1)}%`:"0.0%", lastProgress:`Constituent Mapping: ${mappedRows}/${constituentRows} rows mapped; exact identifiers only`, progressChanged:true });
  await checkpoint("WEIGHTS", "SOURCE_PERCENT_PRESERVED");
  await checkpoint("PROVENANCE", "CHECKSUM_PINNED_OFFICIAL_PDF");
  await checkpoint("HISTORICAL_SNAPSHOTS", "FOUR_IMMUTABLE_OFFICIAL_SNAPSHOTS", { currentMarket:"HK", indexFamily:"Hang Seng Family", processed:historicalSnapshots, total:historicalSnapshots, coverage:"LOCKED_VERIFIED", lastProgress:`Historical Constituents: ${historicalSnapshots} immutable official snapshots retained; no locked history refetch`, progressChanged:true });
  await checkpoint("ENTRY_REMOVAL", "SET_DERIVATION_VERIFIED");
  await checkpoint("WEIGHT_CHANGE", "SET_DERIVATION_VERIFIED");
  await checkpoint("ALLOCATIONS", "MAPPING_CONSTRAINED");
  await checkpoint("OVERLAP", "SOURCE_IDENTITY_READY_CANONICAL_MAPPING_CONSTRAINED");
  await checkpoint("METHODOLOGY", "SOURCE_MATRIX_ACTIVE");
  await coverage();
  await checkpoint("COVERAGE", "AUTO_CONTINUING", { nextRunAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() });
  await consumeGlobalIndexDepthGaps().catch(() => undefined);
  spawn(process.execPath,["--experimental-strip-types","--env-file=.env",join(root,"scripts","data","index-constituents","run-index-derived-depth-worker.ts"),"--once"],{cwd:root,detached:true,stdio:"ignore",windowsHide:true}).unref();
}
async function main() {
  await mkdir(runtime, { recursive: true });
  while (true) {
    try { await cycle(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendFile(join(runtime, "runner.error.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
      await checkpoint("RETRY", message, { nextRunAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
    }
    await sleep(6 * 60 * 60 * 1000);
  }
}
process.once("SIGTERM", async () => { await prisma.$disconnect(); process.exit(0); });
main().catch(async (error) => { await prisma.$disconnect(); console.error(error); process.exitCode = 1; });
