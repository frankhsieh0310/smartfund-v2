import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  atomicJson,
  buildHistoricalRequest,
  createBackfillScopes,
  decodeMopsResponse,
  normalizeHistoricalHtml,
  now,
  readJson,
  sha256,
} from "./run-isolated-mops-ingestion.ts";

type Contract = Parameters<typeof createBackfillScopes>[0] & {
  id: string;
  domain: string;
  endpoint: string;
  method?: "GET" | "POST" | "POST_FORM";
  responseType?: "json" | "html";
  staticParameters?: Record<string, string>;
};
type Registry = { source: string; baseUrl: string; concurrency: 1; maxAttempts: number; minimumRequestIntervalMs: number; domains: Contract[] };
type JobState = "PENDING" | "RUNNING" | "COMPLETE" | "RETRY" | "FAILED";
type Job = { id: string; contractId: string; domain: string; scope: ReturnType<typeof createBackfillScopes>[number]; state: JobState; attempts: number; checkpoint: string | null; recordCount: number; lastError: string | null; updatedAt: string };
type Queue = { version: 1; concurrency: 1; specialAdapterRequired: string[]; items: Job[]; updatedAt: string };

const root = path.resolve("runtime/mops-staging");
const queuePath = path.join(root, "historical-queue.json");
const checkpointPath = path.join(root, "historical-checkpoint.json");
const registryPath = path.resolve("config/mops-missing-data-source-registry.json");
const validationPath = path.join(root, "historical-smoke", "validation-summary.json");
const special = ["FOREIGN_OWNERSHIP_HISTORY", "ASSET_TRANSACTION_HISTORY", "INVESTOR_CONFERENCE_HISTORY", "INSIDER_TRANSFER_HISTORY"];

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function companyIdentifier(record: { rawRowFields?: Record<string, string>; companyCode?: string | null }) {
  if (record.companyCode) return record.companyCode;
  for (const [key, value] of Object.entries(record.rawRowFields ?? {})) {
    if (/公司(?:代號|代碼|編號)|證券代號|股票代號|company.*(?:code|id)|co_id/i.test(key) && /^[0-9A-Z]{4,8}$/i.test(value.trim())) return value.trim();
  }
  return null;
}

function periodOf(scope: Job["scope"]) {
  if (scope.month) return `${scope.year}-${String(scope.month).padStart(2, "0")}`;
  if (scope.quarter) return `${scope.year}-Q${scope.quarter}`;
  if (scope.year) return String(scope.year);
  if (scope.startDate) return `${scope.startDate}:${scope.endDate}`;
  if (scope.page) return `PAGE-${scope.page}`;
  return null;
}

async function persist(job: Job, contract: Contract, sourceReference: string, fetchedAt: string, normalized: ReturnType<typeof normalizeHistoricalHtml>) {
  const period = periodOf(job.scope);
  const records = [...normalized.records, ...normalized.documentReferences].map((record, index) => ({
    ...record,
    companyIdentifier: companyIdentifier(record),
    domain: contract.domain,
    dataType: contract.id,
    period: record.period ?? period,
    source: "TWSE_MOPS_OFFICIAL",
    fetchedAt,
    provenance: { officialSource: "TWSE_MOPS_OFFICIAL", route: contract.endpoint, contract: contract.id, period, sourceReference, fetchedAt },
    sourceKey: sha256(`${contract.id}:${stable(job.scope.params)}:${index}:${stable(record.rawRowFields ?? record.documentReference ?? record)}`),
  }));
  const hashMaterial = records.map(({ fetchedAt: _fetchedAt, provenance, ...record }) => ({ ...record, provenance: { ...provenance, fetchedAt: null } }));
  const contentHash = sha256(stable(hashMaterial));
  const objectPath = path.join(root, "objects", `${contentHash}.json`);
  await mkdir(path.dirname(objectPath), { recursive: true });
  await writeFile(objectPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const manifestName = `HISTORICAL__${contract.id}__${String(job.scope.index).padStart(4, "0")}.json`;
  await atomicJson(path.join(root, "manifests", manifestName), { source: "TWSE_MOPS_OFFICIAL", domain: contract.domain, contract: contract.id, scope: job.scope, sourceReference, fetchedAt, contentHash, recordCount: records.length, objectPath: path.relative(root, objectPath).replaceAll("\\", "/"), provenance: { officialSource: "TWSE_MOPS_OFFICIAL", route: contract.endpoint, contract: contract.id, period, sourceReference, fetchedAt } });
  return { contentHash, recordCount: records.length };
}

async function save(queue: Queue, current: string | null, runState: string) {
  queue.updatedAt = now();
  await atomicJson(queuePath, queue);
  await atomicJson(checkpointPath, { version: 1, concurrency: 1, runState, current, completed: queue.items.filter((job) => job.state === "COMPLETE").map((job) => job.id), retry: queue.items.filter((job) => job.state === "RETRY").map((job) => job.id), failed: queue.items.filter((job) => job.state === "FAILED").map((job) => job.id), resumeCursor: queue.items.find((job) => job.state !== "COMPLETE")?.id ?? null, updatedAt: now() });
}

async function main() {
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as Registry;
  const validation = JSON.parse(await readFile(validationPath, "utf8")) as { pass: string[]; passEmptyValid: string[] };
  if (registry.concurrency !== 1) throw new Error("MOPS_CONCURRENCY_MUST_EQUAL_ONE");
  const eligible = new Set([...validation.pass, ...validation.passEmptyValid]);
  for (const id of special) eligible.delete(id);
  const contracts = registry.domains.filter((contract) => eligible.has(contract.id));
  if (contracts.length !== 17) throw new Error(`ELIGIBLE_CONTRACT_COUNT_MISMATCH:${contracts.length}`);
  const prior = await readJson<Queue>(queuePath);
  const priorById = new Map((prior?.items ?? []).map((job) => [job.id, job]));
  const items = contracts.flatMap((contract) => createBackfillScopes(contract).map((scope) => {
    const id = `${contract.id}:${scope.index}:${sha256(stable(scope.params)).slice(0, 12)}`;
    const old = priorById.get(id);
    return { id, contractId: contract.id, domain: contract.domain, scope, state: old?.state === "RUNNING" ? "PENDING" : old?.state ?? "PENDING", attempts: old?.attempts ?? 0, checkpoint: old?.checkpoint ?? null, recordCount: old?.recordCount ?? 0, lastError: old?.lastError ?? null, updatedAt: old?.updatedAt ?? now() } as Job;
  }));
  if (items.length !== 125) throw new Error(`HISTORICAL_JOB_COUNT_MISMATCH:${items.length}`);
  const queue: Queue = { version: 1, concurrency: 1, specialAdapterRequired: special, items, updatedAt: now() };
  await save(queue, null, "RUNNING");

  for (const job of queue.items) {
    if (job.state === "COMPLETE" || job.state === "FAILED") continue;
    const contract = contracts.find((entry) => entry.id === job.contractId)!;
    while (job.attempts < registry.maxAttempts && job.state !== "COMPLETE") {
      job.state = "RUNNING"; job.attempts += 1; job.updatedAt = now(); await save(queue, job.id, "RUNNING");
      try {
        const request = buildHistoricalRequest(contract as never, job.scope, registry.baseUrl);
        const response = await fetch(request.url, request.init);
        if (!response.ok) throw new Error(`MOPS_HTTP_${response.status}`);
        const fetchedAt = now(); const html = await decodeMopsResponse(response, request.url);
        const normalized = normalizeHistoricalHtml(contract as never, request.url, html, fetchedAt, null, periodOf(job.scope));
        if (normalized.status === "PARTIAL") throw new Error("BACKFILL_CONTRACT_ERROR:PARTIAL_RESPONSE");
        const persisted = await persist(job, contract, request.url, fetchedAt, normalized);
        job.state = "COMPLETE"; job.checkpoint = persisted.contentHash; job.recordCount = persisted.recordCount; job.lastError = null; job.updatedAt = fetchedAt;
      } catch (error) {
        job.lastError = error instanceof Error ? error.message : String(error); job.updatedAt = now();
        const deterministic = /PARSE_FAILED|CONTRACT_MISMATCH|BACKFILL_CONTRACT_ERROR/.test(job.lastError);
        job.state = deterministic || job.attempts >= registry.maxAttempts ? "FAILED" : "RETRY";
      }
      await save(queue, job.id, job.state === "RETRY" ? "RETRY" : "RUNNING");
      if (job.state === "RETRY") await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (job.attempts - 1)));
      await new Promise((resolve) => setTimeout(resolve, registry.minimumRequestIntervalMs));
    }
  }
  const failed = queue.items.filter((job) => job.state === "FAILED").length;
  await save(queue, null, failed ? "PARTIAL" : "COMPLETE");
  const contractsCompleted = contracts.filter((contract) => queue.items.filter((job) => job.contractId === contract.id).every((job) => job.state === "COMPLETE")).length;
  console.log(JSON.stringify({ status: failed ? "PARTIAL" : "COMPLETE", jobs: queue.items.length, completed: queue.items.filter((job) => job.state === "COMPLETE").length, retry: queue.items.filter((job) => job.state === "RETRY").length, failed, contractsCompleted, records: queue.items.reduce((sum, job) => sum + job.recordCount, 0), queuePath, checkpointPath }, null, 2));
}

main().catch(async (error) => {
  await atomicJson(checkpointPath, { version: 1, concurrency: 1, runState: "RUNTIME_BLOCKED", current: null, lastError: error instanceof Error ? error.message : String(error), updatedAt: now() });
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
