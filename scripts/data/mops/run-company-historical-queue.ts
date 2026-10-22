import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  atomicJson,
  buildHistoricalRequest,
  decodeMopsResponse,
  normalizeHistoricalHtml,
  now,
  readJson,
  sha256,
} from "./run-isolated-mops-ingestion.ts";

type Scope = { index: number; mode: string; year?: number; month?: number; quarter?: number; startDate?: string; endDate?: string; page?: number; params: Record<string, string> };
type BaseJob = { id: string; contractId: string; scope: Scope; state: string };
type Contract = { id: string; domain: string; endpoint: string; method?: "GET" | "POST" | "POST_FORM"; responseType?: "json" | "html"; staticParameters?: Record<string, string> };
type Registry = { source: string; baseUrl: string; concurrency: 1; maxAttempts: number; minimumRequestIntervalMs: number; domains: Contract[] };
type Cursor = { baseJobIndex: number; companyIndex: number };
type Stats = { processed: number; complete: number; emptyValid: number; rawSavedParsePending: number; retryExhausted: number; accessBlocked: number; unsupported: number; records: number; documentReferences: number };
type Checkpoint = { version: 1; runState: string; cursor: Cursor; totalBaseJobs: number; companyUniverse: number; totalJobs: number; stats: Stats; contractStats: Record<string, Stats>; lastJob: string | null; lastError: string | null; processId: number; updatedAt: string };

const root = path.resolve("runtime/mops-staging");
const checkpointPath = path.join(root, "company-historical-checkpoint.json");
const registryPath = path.resolve("config/mops-missing-data-source-registry.json");
const baseQueuePath = path.join(root, "historical-queue.json");
const byStockRoot = path.resolve("runtime/mops-by-stock");
const rawRoot = path.join(root, "raw-historical-failures");
const emptyStats = (): Stats => ({ processed: 0, complete: 0, emptyValid: 0, rawSavedParsePending: 0, retryExhausted: 0, accessBlocked: 0, unsupported: 0, records: 0, documentReferences: 0 });

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function periodOf(scope: Scope) { if (scope.month) return `${scope.year}-${String(scope.month).padStart(2, "0")}`; if (scope.quarter) return `${scope.year}-Q${scope.quarter}`; if (scope.year) return String(scope.year); if (scope.startDate) return `${scope.startDate}:${scope.endDate}`; if (scope.page) return `PAGE-${scope.page}`; return null; }
function increment(target: Stats, key: keyof Stats, amount = 1) { target[key] += amount; }

async function saveRaw(contract: Contract, baseJob: BaseJob, company: string, sourceReference: string, fetchedAt: string, html: string, error: string) {
  const key = sha256(`${contract.id}:${baseJob.scope.index}:${company}`);
  const htmlPath = path.join(rawRoot, `${key}.html`); const metadataPath = path.join(rawRoot, `${key}.json`);
  await mkdir(rawRoot, { recursive: true });
  await writeFile(htmlPath, html, { encoding: "utf8", flag: "wx" }).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== "EEXIST") throw failure; });
  await atomicJson(metadataPath, { status: "RAW_SAVED_PARSE_PENDING", contract: contract.id, company, period: periodOf(baseJob.scope), scope: baseJob.scope, sourceReference, fetchedAt, error, contentHash: sha256(html), rawPath: path.relative(root, htmlPath).replaceAll("\\", "/") });
}

async function persist(contract: Contract, baseJob: BaseJob, company: string, sourceReference: string, fetchedAt: string, normalized: ReturnType<typeof normalizeHistoricalHtml>) {
  const period = periodOf(baseJob.scope); const combined = [...normalized.records, ...normalized.documentReferences];
  const records = combined.map((record, index) => ({ ...record, companyCode: company, companyIdentifier: company, domain: contract.domain, dataType: contract.id, period: record.period ?? period, source: "TWSE_MOPS_OFFICIAL", fetchedAt, sourceKey: sha256(`${contract.id}:${baseJob.scope.index}:${company}:${index}:${stable(record.rawRowFields ?? record.documentReference ?? record)}`), provenance: { officialSource: "TWSE_MOPS_OFFICIAL", route: contract.endpoint, contract: contract.id, company, period, sourceReference, fetchedAt } }));
  const hashMaterial = records.map(({ fetchedAt: _fetchedAt, provenance, ...record }) => ({ ...record, provenance: { ...provenance, fetchedAt: null } })); const contentHash = sha256(stable(hashMaterial));
  const objectPath = path.join(root, "objects", `${contentHash}.json`); await mkdir(path.dirname(objectPath), { recursive: true });
  await writeFile(objectPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const manifestName = `HISTORICAL_COMPANY__${contract.id}__${String(baseJob.scope.index).padStart(4, "0")}__${company}.json`;
  await atomicJson(path.join(root, "manifests", manifestName), { source: "TWSE_MOPS_OFFICIAL", domain: contract.domain, contract: contract.id, company, scope: baseJob.scope, sourceReference, fetchedAt, contentHash, recordCount: records.length, objectPath: path.relative(root, objectPath).replaceAll("\\", "/"), provenance: { officialSource: "TWSE_MOPS_OFFICIAL", route: contract.endpoint, contract: contract.id, company, period, sourceReference, fetchedAt } });
  return { records: normalized.records.length, documents: normalized.documentReferences.length };
}

async function saveCheckpoint(checkpoint: Checkpoint) { checkpoint.updatedAt = now(); await atomicJson(checkpointPath, checkpoint); }

async function main() {
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as Registry; if (registry.concurrency !== 1) throw new Error("MOPS_CONCURRENCY_MUST_EQUAL_ONE");
  const baseQueue = JSON.parse(await readFile(baseQueuePath, "utf8")) as { items: BaseJob[] };
  const baseJobs = baseQueue.items.filter((job) => job.state === "FAILED");
  const entries = await readdir(byStockRoot, { withFileTypes: true }); const companies = entries.filter((entry) => entry.isDirectory() && /^[0-9A-Z]{4,8}$/i.test(entry.name)).map((entry) => entry.name).sort();
  if (!baseJobs.length || !companies.length) throw new Error("MOPS_COMPANY_QUEUE_INPUT_EMPTY");
  const prior = await readJson<Checkpoint>(checkpointPath); const checkpoint: Checkpoint = prior ?? { version: 1, runState: "RUNNING", cursor: { baseJobIndex: 0, companyIndex: 0 }, totalBaseJobs: baseJobs.length, companyUniverse: companies.length, totalJobs: baseJobs.length * companies.length, stats: emptyStats(), contractStats: {}, lastJob: null, lastError: null, processId: process.pid, updatedAt: now() };
  checkpoint.processId = process.pid; checkpoint.runState = "RUNNING"; await saveCheckpoint(checkpoint);
  for (let baseIndex = checkpoint.cursor.baseJobIndex; baseIndex < baseJobs.length; baseIndex += 1) {
    const baseJob = baseJobs[baseIndex]; const contract = registry.domains.find((entry) => entry.id === baseJob.contractId); if (!contract) throw new Error(`MISSING_CONTRACT:${baseJob.contractId}`);
    const stats = checkpoint.contractStats[contract.id] ??= emptyStats(); const companyStart = baseIndex === checkpoint.cursor.baseJobIndex ? checkpoint.cursor.companyIndex : 0;
    for (let companyIndex = companyStart; companyIndex < companies.length; companyIndex += 1) {
      const company = companies[companyIndex]; const jobId = `${baseJob.id}:${company}`; checkpoint.lastJob = jobId; checkpoint.lastError = null;
      let terminal = false; let lastHtml = ""; let lastReference = contract.endpoint; let lastFetchedAt = now();
      for (let attempt = 1; attempt <= registry.maxAttempts && !terminal; attempt += 1) {
        try {
          const request = buildHistoricalRequest(contract as never, baseJob.scope as never, registry.baseUrl, company); lastReference = request.url;
          const response = await fetch(request.url, request.init); lastFetchedAt = now(); lastHtml = await decodeMopsResponse(response, request.url);
          if ([403, 429].includes(response.status)) { if (attempt === registry.maxAttempts) { increment(checkpoint.stats, "accessBlocked"); increment(stats, "accessBlocked"); terminal = true; } else await new Promise((resolve) => setTimeout(resolve, 30_000 * attempt)); continue; }
          if ([500, 502, 503, 504].includes(response.status)) { if (attempt === registry.maxAttempts) { increment(checkpoint.stats, "retryExhausted"); increment(stats, "retryExhausted"); terminal = true; } else await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1))); continue; }
          if (!response.ok) { checkpoint.lastError = `MOPS_HTTP_${response.status}`; increment(checkpoint.stats, "unsupported"); increment(stats, "unsupported"); terminal = true; continue; }
          const normalized = normalizeHistoricalHtml(contract as never, request.url, lastHtml, lastFetchedAt, company, periodOf(baseJob.scope));
          if (normalized.status === "PARTIAL") throw new Error("UNSUPPORTED_OFFICIAL_FLOW:PARTIAL_RESPONSE");
          const saved = await persist(contract, baseJob, company, request.url, lastFetchedAt, normalized); increment(checkpoint.stats, "complete"); increment(stats, "complete"); if (normalized.status === "SOURCE_EMPTY") { increment(checkpoint.stats, "emptyValid"); increment(stats, "emptyValid"); } increment(checkpoint.stats, "records", saved.records); increment(stats, "records", saved.records); increment(checkpoint.stats, "documentReferences", saved.documents); increment(stats, "documentReferences", saved.documents); terminal = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error); checkpoint.lastError = message; await saveRaw(contract, baseJob, company, lastReference, lastFetchedAt, lastHtml, message); increment(checkpoint.stats, "rawSavedParsePending"); increment(stats, "rawSavedParsePending"); terminal = true;
        }
      }
      increment(checkpoint.stats, "processed"); increment(stats, "processed"); checkpoint.cursor = companyIndex + 1 < companies.length ? { baseJobIndex: baseIndex, companyIndex: companyIndex + 1 } : { baseJobIndex: baseIndex + 1, companyIndex: 0 }; await saveCheckpoint(checkpoint);
      await new Promise((resolve) => setTimeout(resolve, registry.minimumRequestIntervalMs));
    }
  }
  checkpoint.runState = "COMPLETE_AS_AVAILABLE"; await saveCheckpoint(checkpoint);
  spawnSync(process.execPath, ["--experimental-strip-types", path.resolve("scripts/data/mops/organize-mops-by-stock.ts")], { cwd: process.cwd(), stdio: "inherit" });
  console.log(JSON.stringify(checkpoint, null, 2));
}

main().catch(async (error) => { const prior = await readJson<Checkpoint>(checkpointPath); if (prior) { prior.runState = "BLOCKED"; prior.lastError = error instanceof Error ? error.message : String(error); await saveCheckpoint(prior); } console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
