import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import Papa from "papaparse";
import {
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  persistLifecycleCheckpoint,
  releaseLifecycleLock,
} from "../production/run-lifecycle.ts";

const ROOT = process.cwd();
const JOB_ID = "shared-bis-official";
const RUN_TYPE = process.argv.includes("--canary") ? "CANARY" : "INCREMENTAL";
const REGISTRY_FILE = path.join(ROOT, "config", "bis-shared-official-registry.json");
const CHECKPOINT_FILE = path.join(ROOT, "runtime", "bis", "checkpoint.json");
const RESULT_FILE = path.join(ROOT, "runtime", "bis", "last-run.json");
const FX_TURNOVER_CHECKPOINT_FILE = path.join(ROOT, "runtime", "bis", "fx-turnover-checkpoint.json");
const FX_TURNOVER_RESULT_FILE = path.join(ROOT, "runtime", "bis", "fx-turnover-last-run.json");
const OTC_FX_CHECKPOINT_FILE = path.join(ROOT, "runtime", "bis", "otc-fx-derivatives-checkpoint.json");
const OTC_FX_RESULT_FILE = path.join(ROOT, "runtime", "bis", "otc-fx-derivatives-last-run.json");
const INTERNATIONAL_BANKING_CHECKPOINT_FILE = path.join(ROOT, "runtime", "bis", "international-banking-checkpoint.json");
const INTERNATIONAL_BANKING_RESULT_FILE = path.join(ROOT, "runtime", "bis", "international-banking-last-run.json");
const GLOBAL_LIQUIDITY_CHECKPOINT_FILE = path.join(ROOT, "runtime", "bis", "global-liquidity-checkpoint.json");
const GLOBAL_LIQUIDITY_RESULT_FILE = path.join(ROOT, "runtime", "bis", "global-liquidity-last-run.json");
const HEARTBEAT_FILE = path.join(ROOT, "runtime", "bis", "heartbeat.json");
const PROCESS_LOCK_FILE = path.join(ROOT, "runtime", "bis", "single-writer.lock");
const DATASET_SCHEDULE_FILE = path.join(ROOT, "runtime", "bis", "dataset-schedule.json");
const DESKTOP_WORKER = process.argv.includes("--desktop-worker");
const DAY_MS = 86_400_000;
const MAX_DB_CONCURRENCY = 1;
const FX_TURNOVER_CANARY = process.argv.includes("--fx-turnover-canary");
const OTC_FX_CANARY = process.argv.includes("--otc-fx-canary");
const INTERNATIONAL_BANKING_CANARY = process.argv.includes("--international-banking-canary");
const GLOBAL_LIQUIDITY_CANARY = process.argv.includes("--global-liquidity-canary");

type Registry = {
  source: { baseUrl: string; sharedConsumers: string[] };
  database: { boundedBatchSize: number; maxRetries: number };
  canary: { dataflow: string; version: string; key: string; canonicalSeriesId: string; country: string; currency: string; frequency: "DAILY"; unit: string; maxObservations: number };
  fxTurnoverCanary: { dataflow: string; version: string; key: string; canonicalSeriesId: string; country: string; currency: string; frequency: "ANNUAL"; unit: string; maxObservations: number; checkpoint: string; ordinaryLifecycle: string; remainingCoverageMode: string };
  otcFxDerivativesCanary: { dataflow: string; version: string; key: string; canonicalSeriesId: string; country: string; currency: string; frequency: "ANNUAL"; sourceFrequency: "HALF_YEARLY"; unit: string; maxObservations: number; checkpoint: string; ordinaryLifecycle: string; remainingCoverageMode: string };
  internationalBankingCanary: { dataflow: string; version: string; key: string; canonicalSeriesId: string; country: string; currency: string; frequency: "QUARTERLY"; unit: string; maxObservations: number; checkpoint: string; ordinaryLifecycle: string; remainingCoverageMode: string };
  globalLiquidityCanary: { dataflow: string; version: string; key: string; canonicalSeriesId: string; country: string; currency: string; frequency: "QUARTERLY"; unit: string; maxObservations: number; checkpoint: string; ordinaryLifecycle: string; remainingCoverageMode: string };
  datasetQueue: Array<{ dataflow: string; domain: string; routes: string[]; state: string }>;
};
type BisRow = Record<string, string>;

function pooledDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL_REQUIRED");
  const url = new URL(raw);
  if (url.protocol.startsWith("postgres")) {
    url.searchParams.set("pgbouncer", "true");
    url.searchParams.set("connection_limit", String(MAX_DB_CONCURRENCY));
    url.searchParams.set("pool_timeout", "20");
  }
  return url.toString();
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

type DesktopDataset = { id:string; checkpoint:string; cadenceMs:number; args:string[]; metric:string };
const DESKTOP_DATASETS: DesktopDataset[] = [
  { id:"POLICY_RATE", checkpoint:CHECKPOINT_FILE, cadenceMs:DAY_MS, args:["--canary"], metric:"asOf/observationsPersisted" },
  { id:"FX_TURNOVER", checkpoint:FX_TURNOVER_CHECKPOINT_FILE, cadenceMs:365*DAY_MS, args:["--canary","--fx-turnover-canary"], metric:"checkpoint/observationsPersisted" },
  { id:"OTC_DERIVATIVES", checkpoint:OTC_FX_CHECKPOINT_FILE, cadenceMs:182*DAY_MS, args:["--canary","--otc-fx-canary"], metric:"checkpoint/observationsPersisted" },
  { id:"INTERNATIONAL_BANKING", checkpoint:INTERNATIONAL_BANKING_CHECKPOINT_FILE, cadenceMs:90*DAY_MS, args:["--canary","--international-banking-canary"], metric:"checkpoint/observationsPersisted" },
  { id:"GLOBAL_LIQUIDITY", checkpoint:GLOBAL_LIQUIDITY_CHECKPOINT_FILE, cadenceMs:90*DAY_MS, args:["--canary","--global-liquidity-canary"], metric:"checkpoint/observationsPersisted" },
];

async function readJson(file:string):Promise<any|null>{try{return JSON.parse(await readFile(file,"utf8"));}catch{return null;}}
function checkpointTime(checkpoint:any):number{
  const value=checkpoint?.retrievedAt??checkpoint?.updatedAt??checkpoint?.lastSuccessAt;
  const parsed=Date.parse(value??""); return Number.isFinite(parsed)?parsed:0;
}
async function runDatasetChild(dataset:DesktopDataset):Promise<void>{
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,[...process.execArgv,path.resolve(process.argv[1]),...dataset.args],{cwd:ROOT,env:process.env,stdio:"inherit",windowsHide:true});
    child.once("error",reject); child.once("exit",code=>code===0?resolve():reject(new Error(`${dataset.id}_EXIT_${code}`)));
  });
}
async function desktopWorker():Promise<void>{
  await mkdir(path.dirname(PROCESS_LOCK_FILE),{recursive:true});
  let handle;
  try{handle=await open(PROCESS_LOCK_FILE,"wx");await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),owner:"SHARED_BIS_OFFICIAL_NODE_WORKER"}));}
  catch{const owner=await readJson(PROCESS_LOCK_FILE);try{if(owner?.pid)process.kill(Number(owner.pid),0);throw new Error(`SHARED_BIS_SINGLE_WRITER_ACTIVE:${owner?.pid??"UNKNOWN"}`);}catch(error){if(error instanceof Error&&error.message.startsWith("SHARED_BIS_SINGLE_WRITER_ACTIVE"))throw error;await rm(PROCESS_LOCK_FILE,{force:true});handle=await open(PROCESS_LOCK_FILE,"wx");await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),recoveredStalePid:owner?.pid??null}));}}
  const release=async()=>{await handle?.close().catch(()=>undefined);await rm(PROCESS_LOCK_FILE,{force:true}).catch(()=>undefined);};
  process.once("SIGTERM",()=>{void release().finally(()=>process.exit(0));});
  process.once("SIGINT",()=>{void release().finally(()=>process.exit(0));});
  try{
    const stored=(await readJson(DATASET_SCHEDULE_FILE))?.datasets??{};
    const schedule:Record<string,any>={};
    for(const dataset of DESKTOP_DATASETS){const cp=await readJson(dataset.checkpoint);schedule[dataset.id]=stored[dataset.id]??{status:"SCHEDULED_WAIT",nextEligibleAt:new Date(checkpointTime(cp)+dataset.cadenceMs).toISOString(),targetMetric:dataset.metric,lastCheckpoint:cp?.checkpoint??cp?.asOf??null};}
    while(true){
      const now=Date.now();
      for(const dataset of DESKTOP_DATASETS){const item=schedule[dataset.id];if(Date.parse(item.nextEligibleAt)<=now){try{await runDatasetChild(dataset);const cp=await readJson(dataset.checkpoint);item.status="SCHEDULED_WAIT";item.lastSuccessAt=new Date().toISOString();item.lastCheckpoint=cp?.checkpoint??cp?.asOf??null;item.targetValue=cp?.observationsPersisted??null;item.nextEligibleAt=new Date(Date.now()+dataset.cadenceMs).toISOString();}catch(error){item.status="BLOCKED";item.lastError=error instanceof Error?error.message:String(error);item.nextEligibleAt=new Date(Date.now()+DAY_MS).toISOString();}}}
      const nextRunAt=new Date(Math.min(...Object.values(schedule).map((item:any)=>Date.parse(item.nextEligibleAt)))).toISOString();
      await atomicJson(DATASET_SCHEDULE_FILE,{owner:"SHARED_BIS_OFFICIAL_NODE_WORKER",updatedAt:new Date().toISOString(),datasets:schedule});
      await atomicJson(HEARTBEAT_FILE,{pid:process.pid,state:"SCHEDULED_WAIT",updatedAt:new Date().toISOString(),nextRunAt,datasets:schedule});
      await new Promise(resolve=>setTimeout(resolve,Math.max(60_000,Math.min(DAY_MS,Date.parse(nextRunAt)-Date.now()))));
    }
  }finally{await release();}
}

async function boundedRetry<T>(operation: () => Promise<T>, maxRetries: number): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try { return await operation(); } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/EMAXCONNSESSION|MaxClientsInSessionMode|connection.*limit/i.test(message) || attempt === maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw last;
}

function observationDate(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
  if (/^\d{4}-Q[1-4]$/.test(value)) return new Date(Date.UTC(Number(value.slice(0, 4)), (Number(value.at(-1)) - 1) * 3, 1));
  if (/^\d{4}-S[12]$/.test(value)) return new Date(Date.UTC(Number(value.slice(0, 4)), value.endsWith("S1") ? 0 : 6, 1));
  if (/^\d{4}-\d{2}$/.test(value)) return new Date(`${value}-01T00:00:00.000Z`);
  if (/^\d{4}$/.test(value)) return new Date(`${value}-01-01T00:00:00.000Z`);
  throw new Error(`UNSUPPORTED_BIS_PERIOD:${value}`);
}

async function fetchCanary(registry: Registry): Promise<{ url: string; retrievedAt: string; rows: BisRow[] }> {
  const config = registry.canary;
  const end = new Date();
  const start = new Date(end.getTime() - 21 * 86_400_000).toISOString().slice(0, 10);
  const url = `${registry.source.baseUrl}/data/dataflow/BIS/${config.dataflow}/${config.version}/${config.key}?startPeriod=${start}&dimension_at_observation=AllDimensions`;
  const response = await fetch(url, { headers: { accept: "application/vnd.sdmx.data+csv;version=2.0.0", "user-agent": "SmartFund-BIS-Official/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`BIS_HTTP_${response.status}`);
  const body = await response.text();
  const parsed = Papa.parse<BisRow>(body, { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`BIS_CSV_PARSE:${parsed.errors[0].message}`);
  const rows = parsed.data.filter((row) => row.TIME_PERIOD && Number.isFinite(Number(row.OBS_VALUE))).slice(-config.maxObservations);
  if (!rows.length) throw new Error("BIS_CANARY_EMPTY");
  return { url, retrievedAt: new Date().toISOString(), rows };
}

async function runBisFxDatasetCanary(prisma: PrismaClient, registry: Registry, config: Registry["fxTurnoverCanary"] | Registry["otcFxDerivativesCanary"] | Registry["internationalBankingCanary"] | Registry["globalLiquidityCanary"], output: { checkpointFile: string; resultFile: string; code: string; category: string; fallbackName: string; dimensions: string }): Promise<void> {
  const url = `${registry.source.baseUrl}/data/dataflow/BIS/${config.dataflow}/${config.version}/${config.key}?startPeriod=2016&dimension_at_observation=AllDimensions`;
  const response = await fetch(url, { headers: { accept: "application/vnd.sdmx.data+csv;version=2.0.0", "user-agent": "SmartFund-BIS-Official/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`BIS_FX_DATASET_HTTP_${config.dataflow}_${response.status}`);
  const parsed = Papa.parse<BisRow>(await response.text(), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`BIS_FX_DATASET_CSV_PARSE:${config.dataflow}:${parsed.errors[0].message}`);
  const rows = parsed.data.filter((row) => row.TIME_PERIOD && Number.isFinite(Number(row.OBS_VALUE))).slice(-config.maxObservations);
  if (!rows.length) throw new Error(`BIS_FX_DATASET_CANARY_EMPTY:${config.dataflow}`);
  const retrievedAt = new Date().toISOString();
  const runId = await createLifecycleRun(prisma, JOB_ID, "BIS_FX_TURNOVER", "CANARY", { universeCount: rows.length });
  const summary = createSummary();
  try {
    const latest = rows.at(-1)!;
    const reportedUnit = [latest.UNIT_MEASURE, latest.UNIT_MULT ? `10^${latest.UNIT_MULT}` : null].filter(Boolean).join(" ") || config.unit;
    const series = await boundedRetry(() => prisma.economicSeries.upsert({
      where: { provider_seriesId: { provider: "BIS", seriesId: config.canonicalSeriesId } },
      create: { provider: "BIS", seriesId: config.canonicalSeriesId, code: output.code, name: latest.TITLE?.trim() || output.fallbackName, description: JSON.stringify({ official: true, derived: false, dataset: config.dataflow, key: config.key, dimensions: output.dimensions }), country: config.country, category: output.category, frequency: config.frequency, importance: "HIGH", unit: reportedUnit, source: "Bank for International Settlements", apiUrl: url, lastUpdate: new Date() },
      update: { name: latest.TITLE?.trim() || output.fallbackName, unit: reportedUnit, apiUrl: url, lastUpdate: new Date(), enabled: true },
    }), registry.database.maxRetries);
    for (const row of rows) {
      const date = observationDate(row.TIME_PERIOD);
      const sourceVersion = JSON.stringify({ official: true, derived: false, pit: "LATEST_VINTAGE", revision: row.OBS_STATUS ?? null, dataset: config.dataflow, key: config.key });
      const checksum = createHash("sha256").update(JSON.stringify(row)).digest("hex");
      await boundedRetry(() => prisma.economicValue.upsert({
        where: { seriesId_date: { seriesId: series.id, date } },
        create: { seriesId: series.id, date, value: row.OBS_VALUE, sourceUrl: url, sourceVersion, rawChecksum: checksum, importedAt: new Date(retrievedAt) },
        update: { value: row.OBS_VALUE, sourceUrl: url, sourceVersion, rawChecksum: checksum, importedAt: new Date(retrievedAt) },
      }), registry.database.maxRetries);
      summary.attempted += 1; summary.completed += 1; summary.success += 1; summary.updated += 1;
      await persistLifecycleCheckpoint(prisma, runId, summary, `${config.canonicalSeriesId}:${row.TIME_PERIOD}`, { jobId: JOB_ID, dataset: config.dataflow, runType: "CANARY" });
    }
    const dates = rows.map((row) => observationDate(row.TIME_PERIOD));
    const readback = await prisma.economicValue.findMany({ where: { seriesId: series.id, date: { in: dates } }, orderBy: { date: "asc" } });
    if (readback.length !== rows.length || readback.some((value) => !value.rawChecksum || value.sourceUrl !== url)) throw new Error(`BIS_FX_DATASET_READBACK_FAILED:${config.dataflow}:${readback.length}/${rows.length}`);
    const checkpoint = { source: "BIS", dataset: config.dataflow, key: config.key, canonicalSeriesId: config.canonicalSeriesId, processId: process.pid, state: "AUTO_CONTINUING", observationsPersisted: readback.length, readback: "PASS", lastObservationDate: readback.at(-1)!.date.toISOString(), retrievedAt, checkpoint: `${config.canonicalSeriesId}:${rows.at(-1)!.TIME_PERIOD}`, nextOwner: config.ordinaryLifecycle, remainingCoverageMode: config.remainingCoverageMode, maxDbConcurrency: MAX_DB_CONCURRENCY };
    await atomicJson(output.checkpointFile, checkpoint);
    await atomicJson(output.resultFile, checkpoint);
    await completeLifecycleRun(prisma, runId, summary, readback.at(-1)!.date, checkpoint);
    console.log(JSON.stringify(checkpoint));
  } catch (error) {
    await failLifecycleRun(prisma, runId, error);
    throw error;
  }
}

async function run(): Promise<void> {
  const registry = JSON.parse(await readFile(REGISTRY_FILE, "utf8")) as Registry;
  const prisma = new PrismaClient({ datasources: { db: { url: pooledDatabaseUrl() } } });
  const owner = `desktop:${process.pid}`;
  let runId: string | null = null;
  let locked = false;
  const summary = createSummary();
  try {
    locked = await boundedRetry(() => acquireLifecycleLock(prisma, JOB_ID, owner), registry.database.maxRetries);
    if (!locked) { console.log(JSON.stringify({ status: "SKIPPED_LOCKED", processId: process.pid })); return; }
    if (FX_TURNOVER_CANARY) { await runBisFxDatasetCanary(prisma, registry, registry.fxTurnoverCanary, { checkpointFile: FX_TURNOVER_CHECKPOINT_FILE, resultFile: FX_TURNOVER_RESULT_FILE, code: "BIS_FX_TURNOVER_GLOBAL_FX_SWAPS", category: "BIS_FX_TURNOVER", fallbackName: "BIS global FX swap turnover, daily average", dimensions: "Global; FX swaps; all currencies; all maturities; all counterparties; net-net" }); return; }
    if (OTC_FX_CANARY) { await runBisFxDatasetCanary(prisma, registry, registry.otcFxDerivativesCanary, { checkpointFile: OTC_FX_CHECKPOINT_FILE, resultFile: OTC_FX_RESULT_FILE, code: "BIS_OTC_FX_DERIVATIVES_USD_FORWARDS_SWAPS", category: "BIS_OTC_FX_DERIVATIVES", fallbackName: "BIS global OTC FX forwards and swaps outstanding, USD leg", dimensions: "Global; FX forwards and swaps; USD leg; all maturities; all counterparties; net-net" }); return; }
    if (INTERNATIONAL_BANKING_CANARY) { await runBisFxDatasetCanary(prisma, registry, registry.internationalBankingCanary, { checkpointFile: INTERNATIONAL_BANKING_CHECKPOINT_FILE, resultFile: INTERNATIONAL_BANKING_RESULT_FILE, code: "BIS_LBS_CROSS_BORDER_CLAIMS_USD_GLOBAL", category: "BIS_INTERNATIONAL_BANKING", fallbackName: "BIS global cross-border bank claims, USD", dimensions: "All reporting countries; cross-border total claims; all instruments; USD; all counterparties" }); return; }
    if (GLOBAL_LIQUIDITY_CANARY) { await runBisFxDatasetCanary(prisma, registry, registry.globalLiquidityCanary, { checkpointFile: GLOBAL_LIQUIDITY_CHECKPOINT_FILE, resultFile: GLOBAL_LIQUIDITY_RESULT_FILE, code: "BIS_GLOBAL_USD_LIQUIDITY_NONBANK_EX_US", category: "BIS_GLOBAL_LIQUIDITY", fallbackName: "BIS global USD credit to non-banks outside the United States", dimensions: "USD; non-banks; all countries excluding US residents; cross-border and local foreign-currency credit" }); return; }
    const payload = await fetchCanary(registry);
    runId = await createLifecycleRun(prisma, JOB_ID, "BIS", RUN_TYPE, { universeCount: payload.rows.length });
    const latest = payload.rows.at(-1)!;
    const sourceVersion = JSON.stringify({ official: true, derived: false, pit: "LATEST_VINTAGE", revision: latest.OBS_STATUS ?? null, dataset: registry.canary.dataflow });
    const series = await boundedRetry(() => prisma.economicSeries.upsert({
      where: { provider_seriesId: { provider: "BIS", seriesId: registry.canary.canonicalSeriesId } },
      create: { provider: "BIS", seriesId: registry.canary.canonicalSeriesId, code: `BIS_${registry.canary.dataflow}_US`, name: latest.TITLE?.trim() || "BIS central bank policy rate - United States", description: "Official BIS SDMX observation; shared canonical series for FIXED_INCOME, FX and MACRO consumers.", country: registry.canary.country, category: "POLICY_RATE", frequency: registry.canary.frequency, importance: "HIGH", unit: registry.canary.unit, source: "Bank for International Settlements", apiUrl: payload.url, lastUpdate: new Date() },
      update: { name: latest.TITLE?.trim() || "BIS central bank policy rate - United States", unit: registry.canary.unit, apiUrl: payload.url, lastUpdate: new Date(), enabled: true },
    }), registry.database.maxRetries);
    for (const batchStart of Array.from({ length: Math.ceil(payload.rows.length / registry.database.boundedBatchSize) }, (_, index) => index * registry.database.boundedBatchSize)) {
      const batch = payload.rows.slice(batchStart, batchStart + registry.database.boundedBatchSize);
      for (const row of batch) {
        const date = observationDate(row.TIME_PERIOD);
        const checksum = createHash("sha256").update(JSON.stringify(row)).digest("hex");
        await boundedRetry(() => prisma.economicValue.upsert({
          where: { seriesId_date: { seriesId: series.id, date } },
          create: { seriesId: series.id, date, value: row.OBS_VALUE, sourceUrl: payload.url, sourceVersion, rawChecksum: checksum, importedAt: new Date(payload.retrievedAt) },
          update: { value: row.OBS_VALUE, sourceUrl: payload.url, sourceVersion, rawChecksum: checksum, importedAt: new Date(payload.retrievedAt) },
        }), registry.database.maxRetries);
        summary.attempted += 1; summary.completed += 1; summary.success += 1; summary.updated += 1;
      }
      await persistLifecycleCheckpoint(prisma, runId, summary, `${registry.canary.canonicalSeriesId}:${batch.at(-1)!.TIME_PERIOD}`, { jobId: JOB_ID, runType: RUN_TYPE });
    }
    const readback = await prisma.economicValue.findMany({ where: { seriesId: series.id, date: { in: payload.rows.map((row) => observationDate(row.TIME_PERIOD)) } }, orderBy: { date: "asc" } });
    if (readback.length !== payload.rows.length) throw new Error(`READBACK_COUNT_MISMATCH:${readback.length}/${payload.rows.length}`);
    const checkpoint = {
      source: "BIS", dataset: registry.canary.dataflow, series: registry.canary.canonicalSeriesId,
      asOf: latest.TIME_PERIOD, retrievedAt: payload.retrievedAt, unit: registry.canary.unit,
      frequency: registry.canary.frequency, country: registry.canary.country, geography: "United States",
      officialDerived: "OFFICIAL", pitRevision: sourceVersion, processId: process.pid,
      observationsPersisted: readback.length, lastObservationDate: readback.at(-1)!.date.toISOString(),
      readback: "PASS", nextDataset: registry.datasetQueue[0].dataflow, nextState: registry.datasetQueue[0].state,
      autoContinuing: true, fullBackfillOwner: "SHARED_BIS_OFFICIAL_NODE_WORKER",
    };
    await atomicJson(CHECKPOINT_FILE, checkpoint);
    await atomicJson(RESULT_FILE, { ...checkpoint, runId, dbConcurrency: MAX_DB_CONCURRENCY, sharedConsumers: registry.source.sharedConsumers });
    await completeLifecycleRun(prisma, runId, summary, readback.at(-1)!.date, { status: "PASS", readbackCount: readback.length, canonicalSeriesId: registry.canary.canonicalSeriesId });
    const turnoverRoute = registry.datasetQueue.find((item) => item.dataflow === registry.fxTurnoverCanary.dataflow);
    if (process.argv.includes("--resume") && turnoverRoute?.state === "AUTO_CONTINUING") await runBisFxDatasetCanary(prisma, registry, registry.fxTurnoverCanary, { checkpointFile: FX_TURNOVER_CHECKPOINT_FILE, resultFile: FX_TURNOVER_RESULT_FILE, code: "BIS_FX_TURNOVER_GLOBAL_FX_SWAPS", category: "BIS_FX_TURNOVER", fallbackName: "BIS global FX swap turnover, daily average", dimensions: "Global; FX swaps; all currencies; all maturities; all counterparties; net-net" });
    const otcRoute = registry.datasetQueue.find((item) => item.dataflow === registry.otcFxDerivativesCanary.dataflow);
    if (process.argv.includes("--resume") && otcRoute?.state === "AUTO_CONTINUING") await runBisFxDatasetCanary(prisma, registry, registry.otcFxDerivativesCanary, { checkpointFile: OTC_FX_CHECKPOINT_FILE, resultFile: OTC_FX_RESULT_FILE, code: "BIS_OTC_FX_DERIVATIVES_USD_FORWARDS_SWAPS", category: "BIS_OTC_FX_DERIVATIVES", fallbackName: "BIS global OTC FX forwards and swaps outstanding, USD leg", dimensions: "Global; FX forwards and swaps; USD leg; all maturities; all counterparties; net-net" });
    const bankingRoute = registry.datasetQueue.find((item) => item.dataflow === registry.internationalBankingCanary.dataflow);
    if (process.argv.includes("--resume") && bankingRoute?.state === "AUTO_CONTINUING") await runBisFxDatasetCanary(prisma, registry, registry.internationalBankingCanary, { checkpointFile: INTERNATIONAL_BANKING_CHECKPOINT_FILE, resultFile: INTERNATIONAL_BANKING_RESULT_FILE, code: "BIS_LBS_CROSS_BORDER_CLAIMS_USD_GLOBAL", category: "BIS_INTERNATIONAL_BANKING", fallbackName: "BIS global cross-border bank claims, USD", dimensions: "All reporting countries; cross-border total claims; all instruments; USD; all counterparties" });
    const liquidityRoute = registry.datasetQueue.find((item) => item.dataflow === registry.globalLiquidityCanary.dataflow);
    if (process.argv.includes("--resume") && liquidityRoute?.state === "AUTO_CONTINUING") await runBisFxDatasetCanary(prisma, registry, registry.globalLiquidityCanary, { checkpointFile: GLOBAL_LIQUIDITY_CHECKPOINT_FILE, resultFile: GLOBAL_LIQUIDITY_RESULT_FILE, code: "BIS_GLOBAL_USD_LIQUIDITY_NONBANK_EX_US", category: "BIS_GLOBAL_LIQUIDITY", fallbackName: "BIS global USD credit to non-banks outside the United States", dimensions: "USD; non-banks; all countries excluding US residents; cross-border and local foreign-currency credit" });
    console.log(JSON.stringify(checkpoint));
  } catch (error) {
    if (runId) await failLifecycleRun(prisma, runId, error);
    throw error;
  } finally {
    if (locked) await releaseLifecycleLock(prisma, JOB_ID, owner).catch(() => undefined);
    await prisma.$disconnect();
  }
}

(DESKTOP_WORKER?desktopWorker():run()).catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
