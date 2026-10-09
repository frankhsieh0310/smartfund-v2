import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { DurableFileArchive } from "../../../lib/data-platform/archive/DurableFileArchive.ts";
import { validateWorkerOwnershipFromEnvironment } from "../governance/worker-ownership.ts";
import {
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  heartbeatLifecycleLock,
  pauseLifecycleRun,
  persistLifecycleCheckpoint,
  releaseLifecycleLock,
  type RunSummary,
} from "../production/run-lifecycle.ts";

const JOB_ID = "official-bond-global-completion-queue";
const RUN_TYPE = "FIRST_PASS_SOURCE_CANARY";
const REGISTRY_PATH = path.resolve("config", "global-individual-bond-registry.json");
const MISSING_MATRIX_PATH = path.resolve("config", "bond-missing-matrix.json");
const RUNTIME_ROOT = path.resolve(process.env.GLOBAL_BOND_RUNTIME_ROOT ?? path.join("runtime", "bond", "global-individual-bond-queue"));
const STATE_PATH = path.join(RUNTIME_ROOT, "state.json");
const CHECKPOINT_PATH = path.join(RUNTIME_ROOT, "checkpoint.json");
const HEARTBEAT_PATH = path.join(RUNTIME_ROOT, "heartbeat.json");
const BLOCKERS_PATH = path.join(RUNTIME_ROOT, "blockers.jsonl");
const LOCK_PATH = path.join(RUNTIME_ROOT, "worker.lock.json");
const MAX_SOURCE_BYTES = Number.parseInt(process.env.GLOBAL_BOND_MAX_SOURCE_BYTES ?? "5242880", 10);
const SOURCE_TIMEOUT_MS = Number.parseInt(process.env.GLOBAL_BOND_SOURCE_TIMEOUT_MS ?? "25000", 10);
const RAILWAY_OWNED_SCOPES = new Set(["US_TREASURY", "TAIWAN_GOVERNMENT", "FINLAND_GOVERNMENT"]);

type RegistrySource = { name: string; url: string; role: string };
type RegistryEntry = {
  priority: number;
  market?: string;
  category?: string;
  officialSources?: Array<RegistrySource | string>;
  officialRegistryDependency?: string[];
  status: string;
  blocker: string | null;
  sourceCanary?: Record<string, unknown>;
  [key: string]: unknown;
};
type Registry = {
  version: number;
  snapshotAt: string;
  governmentRegistry: RegistryEntry[];
  corporateRegistry: RegistryEntry[];
  specialRegistry: RegistryEntry[];
  checkpoint: { currentCountry: string; currentLayer: string; nextCountry: string | null; continuing: boolean };
  coverageSnapshot: Record<string, unknown>;
};
type QueueItem = { category: "GOVERNMENT" | "CORPORATE" | "SPECIAL"; key: string; entry: RegistryEntry };
type SourceEvidence = {
  name: string;
  role: string;
  url: string;
  finalUrl: string | null;
  attemptedAt: string;
  status: "PASS" | "BLOCKED";
  blocker: string | null;
  retryable: boolean;
  httpStatus: number | null;
  contentType: string | null;
  bytes: number;
  truncated: boolean;
  sha256: string | null;
  exception: string | null;
  payload: Uint8Array | null;
};
type RuntimeState = {
  workerId: string;
  processId: number;
  commandLine: string;
  startTime: string;
  heartbeatTime: string;
  currentCategory: string;
  currentCountry: string;
  currentLayer: string;
  currentJobId: string;
  currentSecurity: string | null;
  checkpoint: string;
  checkpointUpdatedAt: string;
  universe: number | null;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  retryable: number;
  nonRetryable: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  archiveFilesCreated: number;
  archiveBytes: number;
  latestProgressDelta: number;
  progressEvents: Array<{ at: string; delta: number }>;
  identifierCoverage: string;
  termsCoverage: string;
  historicalCoverage: string;
  latestCoverage: string;
  freshnessCoverage: string;
  productionCoverage: string;
  activeLock: boolean;
  activeLifecycle: boolean;
  blocker: string | null;
  nextCountry: string | null;
  nextLayer: string | null;
  continuing: boolean;
  missingMatrixMarkets: number;
};

function now(): string {
  return new Date().toISOString();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonIfExists<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function normalizeSources(entry: RegistryEntry): RegistrySource[] {
  return (entry.officialSources ?? []).map((source, index) =>
    typeof source === "string" ? { name: `OFFICIAL_SOURCE_${index + 1}`, url: source, role: "SOURCE_READINESS" } : source,
  );
}

function buildQueue(registry: Registry): QueueItem[] {
  return [
    ...registry.governmentRegistry.map((entry) => ({ category: "GOVERNMENT" as const, key: String(entry.market), entry })),
    ...registry.corporateRegistry.map((entry) => ({ category: "CORPORATE" as const, key: String(entry.market), entry })),
    ...registry.specialRegistry.map((entry) => ({ category: "SPECIAL" as const, key: String(entry.category), entry })),
  ].filter((item) => !RAILWAY_OWNED_SCOPES.has(item.key));
}

function queueStartIndex(queue: QueueItem[], registry: Registry, checkpoint: { key?: string } | null): number {
  const key = checkpoint?.key ?? registry.checkpoint.currentCountry;
  const index = queue.findIndex((item) => item.key === key);
  if (index >= 0) return index;
  throw new Error(`GLOBAL_BOND_CHECKPOINT_NOT_IN_REGISTRY:${key}`);
}

function isAlreadyFirstPassProcessed(entry: RegistryEntry): boolean {
  if (entry.status === "PRODUCTION_COMPLETE") return true;
  return Boolean(entry.sourceCanary && ["PASS", "BLOCKED"].includes(String(entry.sourceCanary.status ?? entry.sourceCanary.dryRunStatus)));
}

function detectBlocker(status: number | null, bodyText: string, exception: string | null): { code: string; retryable: boolean } {
  if (exception && /timeout|timed out|abort/i.test(exception)) return { code: "BLOCKED_NETWORK_TIMEOUT", retryable: true };
  if (status === 401) return { code: "BLOCKED_SOURCE_AUTH", retryable: false };
  if (status === 403) return { code: "BLOCKED_HTTP_403", retryable: true };
  if (/shieldsquare|hcaptcha|captcha|bot protection|imperva|access denied/i.test(bodyText)) return { code: "BLOCKED_BOT_PROTECTION", retryable: true };
  return { code: "BLOCKED_SOURCE_ACCESS", retryable: true };
}

async function readBoundedBody(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const remaining = MAX_SOURCE_BYTES - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    const chunk = result.value.length > remaining ? result.value.slice(0, remaining) : result.value;
    chunks.push(chunk);
    total += chunk.length;
    if (result.value.length > remaining || total >= MAX_SOURCE_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

async function probeSource(source: RegistrySource): Promise<SourceEvidence> {
  const attemptedAt = now();
  try {
    const response = await fetch(source.url, {
      redirect: "follow",
      headers: { Accept: "*/*", "User-Agent": process.env.SMARTFUND_DATA_USER_AGENT ?? "SmartFund/1.0 official-data queue" },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
    const { bytes, truncated } = await readBoundedBody(response);
    const contentType = response.headers.get("content-type");
    const bodyText = /text|html|json|xml/i.test(contentType ?? "") ? new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 131_072)) : "";
    const meaningful = response.ok && bytes.length > 0 && !/shieldsquare|hcaptcha|captcha|bot protection|imperva|access denied/i.test(bodyText);
    if (!meaningful) {
      const blocker = detectBlocker(response.status, bodyText, null);
      return { name: source.name, role: source.role, url: source.url, finalUrl: response.url, attemptedAt, status: "BLOCKED", blocker: blocker.code, retryable: blocker.retryable, httpStatus: response.status, contentType, bytes: bytes.length, truncated, sha256: bytes.length ? sha256(bytes) : null, exception: null, payload: bytes.length ? bytes : null };
    }
    return { name: source.name, role: source.role, url: source.url, finalUrl: response.url, attemptedAt, status: "PASS", blocker: null, retryable: false, httpStatus: response.status, contentType, bytes: bytes.length, truncated, sha256: sha256(bytes), exception: null, payload: bytes };
  } catch (error) {
    const exception = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    const blocker = detectBlocker(null, "", exception);
    return { name: source.name, role: source.role, url: source.url, finalUrl: null, attemptedAt, status: "BLOCKED", blocker: blocker.code, retryable: blocker.retryable, httpStatus: null, contentType: null, bytes: 0, truncated: false, sha256: null, exception, payload: null };
  }
}

function safeFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "source";
}

async function archiveEvidence(item: QueueItem, evidence: SourceEvidence[], runId: string): Promise<{ files: number; bytes: number; replay: string; manifestPath: string }> {
  const root = path.join(RUNTIME_ROOT, "runs", runId, item.key);
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  const archiveFiles: Array<{ localPath: string; logicalPath: string; contentType: string; sourceDocumentId: string; sourceUpdatedAt?: string; fetchedAt: string }> = [];
  let bytes = 0;
  for (const [index, source] of evidence.entries()) {
    if (!source.payload) continue;
    const extension = /json/i.test(source.contentType ?? "") ? "json" : /pdf/i.test(source.contentType ?? "") ? "pdf" : /spreadsheet|excel/i.test(source.contentType ?? "") ? "xlsx" : /xml/i.test(source.contentType ?? "") ? "xml" : "html";
    const localPath = path.join(staging, `${index + 1}-${safeFileName(source.name)}.${extension}`);
    await writeFile(localPath, source.payload);
    archiveFiles.push({ localPath, logicalPath: `raw/${item.category}/${item.key}/${path.basename(localPath)}`, contentType: source.contentType ?? "application/octet-stream", sourceDocumentId: source.finalUrl ?? source.url, fetchedAt: source.attemptedAt });
    bytes += source.payload.length;
  }
  const normalizedPath = path.join(staging, "source-evidence.json");
  const normalized = evidence.map(({ payload: _payload, ...source }) => source);
  await writeFile(normalizedPath, `${JSON.stringify({ item: { category: item.category, key: item.key }, evidence: normalized }, null, 2)}\n`, "utf8");
  archiveFiles.push({ localPath: normalizedPath, logicalPath: `normalized/${item.category}/${item.key}/source-evidence.json`, contentType: "application/json", sourceDocumentId: `registry:${item.key}`, fetchedAt: now() });
  bytes += Buffer.byteLength(JSON.stringify(normalized));
  const archive = new DurableFileArchive({ root: path.join(RUNTIME_ROOT, "durable-archive"), prefix: "global-bond-queue" });
  const result = await archive.archiveRun({ runId: `${runId}-${item.key}`, sourceNamespace: `GLOBAL_BOND_${item.key}`, parserVersion: "1.0.0", files: archiveFiles });
  const replay = await archive.restoreAndReplay(result.manifestPath);
  return { files: result.entries, bytes, replay: replay.status, manifestPath: result.manifestPath };
}

function blockerFromEvidence(evidence: SourceEvidence[]): string | null {
  if (evidence.some((source) => source.status === "PASS")) return null;
  const order = ["BLOCKED_SOURCE_AUTH", "BLOCKED_HTTP_403", "BLOCKED_BOT_PROTECTION", "BLOCKED_NETWORK_TIMEOUT", "BLOCKED_SOURCE_ACCESS"];
  return order.find((code) => evidence.some((source) => source.blocker === code)) ?? "BLOCKED_SOURCE_ACCESS";
}

function registryEntry(registry: Registry, item: QueueItem): RegistryEntry {
  const entries = item.category === "GOVERNMENT" ? registry.governmentRegistry : item.category === "CORPORATE" ? registry.corporateRegistry : registry.specialRegistry;
  const found = entries.find((entry) => (entry.market ?? entry.category) === item.key);
  if (!found) throw new Error(`GLOBAL_BOND_REGISTRY_ENTRY_NOT_FOUND:${item.category}:${item.key}`);
  return found;
}

async function updateRegistryAfterAttempt(registry: Registry, item: QueueItem, evidence: SourceEvidence[], archive: { files: number; bytes: number; replay: string; manifestPath: string }, next: QueueItem | null, nextAfterNext: QueueItem | null): Promise<string | null> {
  const entry = registryEntry(registry, item);
  const blocker = blockerFromEvidence(evidence);
  const passed = evidence.filter((source) => source.status === "PASS").length;
  const failed = evidence.length - passed;
  entry.sourceCanary = {
    status: blocker ? "BLOCKED" : "PASS",
    completedAt: now(),
    mode: "BOUNDED_SOURCE_READINESS",
    attemptedSources: evidence.length,
    passedSources: passed,
    blockedSources: failed,
    databaseWrites: 0,
    durableArchiveReplay: archive.replay,
    archiveFiles: archive.files,
    archiveBytes: archive.bytes,
    manifestPath: archive.manifestPath,
    evidence: evidence.map(({ payload: _payload, ...source }) => source),
  };
  if (blocker) {
    entry.status = blocker;
    entry.blocker = blocker;
  } else {
    entry.status = "SOURCE_READINESS_CANARY_COMPLETE";
  }
  registry.snapshotAt = now();
  registry.checkpoint = {
    currentCountry: next?.key ?? "FIRST_PASS_COMPLETE",
    currentLayer: next ? "UNIVERSE_SOURCE_CANARY" : "FIRST_PASS_COMPLETE",
    nextCountry: nextAfterNext?.key ?? null,
    continuing: Boolean(next),
  };
  await writeJsonAtomic(REGISTRY_PATH, registry);
  return blocker;
}

async function recordBoundedAttemptFailure(registry: Registry, item: QueueItem, blocker: string, error: unknown, next: QueueItem | null, nextAfterNext: QueueItem | null, evidence: SourceEvidence[]): Promise<void> {
  const entry = registryEntry(registry, item);
  entry.status = blocker;
  entry.blocker = blocker;
  entry.sourceCanary = {
    status: "BLOCKED",
    completedAt: now(),
    mode: "BOUNDED_SOURCE_READINESS",
    databaseWrites: 0,
    blocker,
    exception: error instanceof Error ? `${error.name}:${error.message}` : String(error),
    evidence: evidence.map(({ payload: _payload, ...source }) => source),
  };
  registry.snapshotAt = now();
  registry.checkpoint = {
    currentCountry: next?.key ?? "FIRST_PASS_COMPLETE",
    currentLayer: next ? "UNIVERSE_SOURCE_CANARY" : "FIRST_PASS_COMPLETE",
    nextCountry: nextAfterNext?.key ?? null,
    continuing: Boolean(next),
  };
  await writeJsonAtomic(REGISTRY_PATH, registry);
}

async function acquireLocalWorkerLock(): Promise<FileHandle> {
  await mkdir(RUNTIME_ROOT, { recursive: true });
  try {
    const existing = await readJson<{ pid: number }>(LOCK_PATH);
    if (Number.isInteger(existing.pid)) {
      try {
        process.kill(existing.pid, 0);
        throw new Error(`GLOBAL_BOND_WORKER_ALREADY_RUNNING:${existing.pid}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("GLOBAL_BOND_WORKER_ALREADY_RUNNING")) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await unlink(LOCK_PATH).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(LOCK_PATH, "wx");
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: now(), commandLine: process.argv.join(" ") }, null, 2)}\n`);
  return handle;
}

function heartbeatPayload(state: RuntimeState): Record<string, unknown> {
  const cutoff = Date.now() - 15 * 60_000;
  const last15MinProgressDelta = state.progressEvents.filter((event) => Date.parse(event.at) >= cutoff).reduce((sum, event) => sum + event.delta, 0);
  return {
    WORKER_ID: state.workerId,
    PROCESS_ID: state.processId,
    PROCESS_RUNNING: "YES",
    COMMAND_LINE: state.commandLine,
    START_TIME: state.startTime,
    HEARTBEAT_TIME: state.heartbeatTime,
    ELAPSED_TIME_MS: Date.now() - Date.parse(state.startTime),
    CURRENT_CATEGORY: state.currentCategory,
    CURRENT_COUNTRY: state.currentCountry,
    CURRENT_LAYER: state.currentLayer,
    CURRENT_JOB_ID: state.currentJobId,
    CURRENT_SYMBOL_OR_SECURITY: state.currentSecurity,
    CHECKPOINT: state.checkpoint,
    CHECKPOINT_UPDATED_AT: state.checkpointUpdatedAt,
    UNIVERSE: state.universe,
    ATTEMPTED: state.attempted,
    SUCCEEDED: state.succeeded,
    FAILED: state.failed,
    SKIPPED: state.skipped,
    RETRYABLE: state.retryable,
    NON_RETRYABLE: state.nonRetryable,
    ROWS_INSERTED: state.rowsInserted,
    ROWS_UPDATED: state.rowsUpdated,
    ROWS_UNCHANGED: state.rowsUnchanged,
    ARCHIVE_FILES_CREATED: state.archiveFilesCreated,
    ARCHIVE_BYTES: state.archiveBytes,
    LATEST_PROGRESS_DELTA: state.latestProgressDelta,
    LAST_15_MIN_PROGRESS_DELTA: last15MinProgressDelta,
    IDENTIFIER_COVERAGE: state.identifierCoverage,
    TERMS_COVERAGE: state.termsCoverage,
    HISTORICAL_COVERAGE: state.historicalCoverage,
    LATEST_COVERAGE: state.latestCoverage,
    FRESHNESS_COVERAGE: state.freshnessCoverage,
    PRODUCTION_COVERAGE: state.productionCoverage,
    ACTIVE_LOCK: state.activeLock,
    ACTIVE_LIFECYCLE: state.activeLifecycle,
    BLOCKER: state.blocker,
    NEXT_COUNTRY: state.nextCountry,
    NEXT_LAYER: state.nextLayer,
    CONTINUING: state.continuing ? "YES" : "NO",
  };
}

async function emitHeartbeat(state: RuntimeState): Promise<void> {
  state.heartbeatTime = now();
  state.progressEvents = state.progressEvents.filter((event) => Date.parse(event.at) >= Date.now() - 30 * 60_000);
  await Promise.all([writeJsonAtomic(STATE_PATH, state), writeJsonAtomic(HEARTBEAT_PATH, heartbeatPayload(state))]);
  console.log(JSON.stringify({ type: "GLOBAL_BOND_HEARTBEAT", ...heartbeatPayload(state) }));
}

async function main(): Promise<void> {
  if (!process.argv.includes("--resume")) throw new Error("GLOBAL_BOND_QUEUE_REQUIRES_RESUME_FLAG");
  const localLock = await acquireLocalWorkerLock();
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
  const owner = `${process.env.SMARTFUND_NODE_ID ?? "smartfund-master"}:${hostname()}:${process.pid}`;
  let runId: string | null = null;
  let dbLock = false;
  let stopRequested = false;
  const onSignal = (): void => { stopRequested = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const startTime = now();
  const missingMatrix = await readJsonIfExists<{ markets?: unknown[] }>(MISSING_MATRIX_PATH, {});
  const registry = await readJson<Registry>(REGISTRY_PATH);
  const queue = buildQueue(registry);
  const fileCheckpoint = await readJsonIfExists<{ key?: string } | null>(CHECKPOINT_PATH, null);
  const startIndex = queueStartIndex(queue, registry, fileCheckpoint);
  await validateWorkerOwnershipFromEnvironment({ domain: "BOND", market: queue[startIndex].key, mode: "COMPLETION", dryRun: false });
  const summary: RunSummary = createSummary();
  const state: RuntimeState = {
    workerId: process.env.SMARTFUND_NODE_ID ?? "smartfund-master",
    processId: process.pid,
    commandLine: process.argv.join(" "),
    startTime,
    heartbeatTime: startTime,
    currentCategory: queue[startIndex].category,
    currentCountry: queue[startIndex].key,
    currentLayer: "UNIVERSE_SOURCE_CANARY",
    currentJobId: JOB_ID,
    currentSecurity: null,
    checkpoint: queue[startIndex].key,
    checkpointUpdatedAt: startTime,
    universe: null,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    retryable: 0,
    nonRetryable: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    archiveFilesCreated: 0,
    archiveBytes: 0,
    latestProgressDelta: 0,
    progressEvents: [],
    identifierCoverage: "NOT_MEASURABLE_SOURCE_FIRST_PASS",
    termsCoverage: "NOT_MEASURABLE_SOURCE_FIRST_PASS",
    historicalCoverage: "2/39=5.128%_GOVERNMENT_MARKET_LEVEL",
    latestCoverage: "1/39=2.564%_PRODUCTION",
    freshnessCoverage: "1/39=2.564%_PRODUCTION",
    productionCoverage: "1/39=2.564%_GOVERNMENT",
    activeLock: false,
    activeLifecycle: false,
    blocker: null,
    nextCountry: queue[startIndex + 1]?.key ?? null,
    nextLayer: "UNIVERSE_SOURCE_CANARY",
    continuing: true,
    missingMatrixMarkets: missingMatrix.markets?.length ?? 0,
  };
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  try {
    dbLock = await acquireLifecycleLock(prisma, JOB_ID, owner);
    if (!dbLock) throw new Error("GLOBAL_BOND_QUEUE_ACTIVE_DB_LOCK");
    runId = await createLifecycleRun(prisma, JOB_ID, "GLOBAL_BOND", RUN_TYPE, { universeCount: queue.length - startIndex });
    state.activeLock = true;
    state.activeLifecycle = true;
    await emitHeartbeat(state);
    heartbeatTimer = setInterval(() => {
      void heartbeatLifecycleLock(prisma, JOB_ID, owner)
        .then(() => emitHeartbeat(state))
        .catch((error) => console.error(JSON.stringify({ type: "GLOBAL_BOND_HEARTBEAT_ERROR", error: error instanceof Error ? error.message : String(error) })));
    }, 60_000);

    for (let index = startIndex; index < queue.length && !stopRequested; index += 1) {
      const liveRegistry = await readJson<Registry>(REGISTRY_PATH);
      const liveQueue = buildQueue(liveRegistry);
      const item = liveQueue[index];
      const next = liveQueue[index + 1] ?? null;
      const nextAfterNext = liveQueue[index + 2] ?? null;
      await validateWorkerOwnershipFromEnvironment({ domain: "BOND", market: item.key, mode: "COMPLETION", dryRun: false });
      state.currentCategory = item.category;
      state.currentCountry = item.key;
      state.currentLayer = "UNIVERSE_SOURCE_CANARY";
      state.nextCountry = next?.key ?? null;
      state.nextLayer = next ? "UNIVERSE_SOURCE_CANARY" : null;
      state.blocker = null;
      state.latestProgressDelta = 0;
      if (isAlreadyFirstPassProcessed(item.entry)) {
        state.skipped += 1;
        summary.noUpdate += 1;
        state.checkpoint = next?.key ?? "FIRST_PASS_COMPLETE";
        state.checkpointUpdatedAt = now();
        await writeJsonAtomic(CHECKPOINT_PATH, { category: next?.category ?? null, key: next?.key ?? "FIRST_PASS_COMPLETE", layer: next ? "UNIVERSE_SOURCE_CANARY" : "FIRST_PASS_COMPLETE", updatedAt: state.checkpointUpdatedAt, reason: "ALREADY_PROCESSED" });
        continue;
      }
      const sources = normalizeSources(item.entry);
      let evidence: SourceEvidence[] = [];
      let archive = { files: 0, bytes: 0, replay: "NOT_CREATED", manifestPath: "" };
      let blocker: string | null = null;
      try {
        if (!sources.length) {
          evidence = [{ name: "REGISTRY_DEPENDENCY", role: "SOURCE_READINESS", url: "", finalUrl: null, attemptedAt: now(), status: "BLOCKED", blocker: "BLOCKED_SOURCE_ACCESS", retryable: false, httpStatus: null, contentType: null, bytes: 0, truncated: false, sha256: null, exception: `NO_DIRECT_OFFICIAL_SOURCE:${(item.entry.officialRegistryDependency ?? []).join(",")}`, payload: null }];
        } else {
          evidence = await Promise.all(sources.map(probeSource));
        }
        const attemptRunId = randomUUID();
        archive = await archiveEvidence(item, evidence, attemptRunId);
        if (archive.replay !== "PASS") throw new Error(`GLOBAL_BOND_ARCHIVE_REPLAY_FAILED:${item.key}`);
        blocker = await updateRegistryAfterAttempt(liveRegistry, item, evidence, archive, next, nextAfterNext);
      } catch (error) {
        blocker = /archive|write|rename|storage/i.test(error instanceof Error ? error.message : String(error)) ? "BLOCKED_CANONICAL_STORAGE" : "BLOCKED_SOURCE_ACCESS";
        await recordBoundedAttemptFailure(liveRegistry, item, blocker, error, next, nextAfterNext, evidence);
      }
      state.attempted += 1;
      summary.attempted += 1;
      if (blocker) {
        state.failed += 1;
        state.blocker = blocker;
        const retryable = evidence.some((source) => source.retryable);
        if (retryable) {
          state.retryable += 1;
          summary.retryableFailure += 1;
        } else {
          state.nonRetryable += 1;
          summary.permanentUnavailable += 1;
        }
        await appendFile(BLOCKERS_PATH, `${JSON.stringify({ at: now(), category: item.category, key: item.key, blocker, evidence: evidence.map(({ payload: _payload, ...source }) => source) })}\n`, "utf8");
      } else {
        state.succeeded += 1;
        summary.completed += 1;
        summary.success += 1;
      }
      state.archiveFilesCreated += archive.files;
      state.archiveBytes += archive.bytes;
      state.latestProgressDelta = 1;
      state.progressEvents.push({ at: now(), delta: 1 });
      state.checkpoint = next?.key ?? "FIRST_PASS_COMPLETE";
      state.checkpointUpdatedAt = now();
      state.nextCountry = next?.key ?? null;
      await writeJsonAtomic(CHECKPOINT_PATH, { category: next?.category ?? null, key: next?.key ?? "FIRST_PASS_COMPLETE", layer: next ? "UNIVERSE_SOURCE_CANARY" : "FIRST_PASS_COMPLETE", updatedAt: state.checkpointUpdatedAt, previous: item.key, previousBlocker: blocker });
      if (!runId) throw new Error("GLOBAL_BOND_LIFECYCLE_RUN_NOT_CREATED");
      await heartbeatLifecycleLock(prisma, JOB_ID, owner);
      await persistLifecycleCheckpoint(prisma, runId, summary, item.key, { jobId: JOB_ID, runType: RUN_TYPE });
      await emitHeartbeat(state);
    }

    state.continuing = false;
    state.activeLifecycle = false;
    state.activeLock = false;
    state.currentLayer = stopRequested ? "PAUSED_AT_CHECKPOINT" : "FIRST_PASS_COMPLETE";
    if (!runId) throw new Error("GLOBAL_BOND_LIFECYCLE_RUN_NOT_CREATED");
    if (stopRequested) await pauseLifecycleRun(prisma, runId);
    else await completeLifecycleRun(prisma, runId, summary, null, { status: "PASS", firstPassComplete: true, blocked: state.failed, succeeded: state.succeeded, skipped: state.skipped });
    await emitHeartbeat(state);
  } catch (error) {
    if (runId) await failLifecycleRun(prisma, runId, error);
    state.activeLifecycle = false;
    state.blocker = error instanceof Error ? error.message : String(error);
    state.continuing = false;
    await emitHeartbeat(state).catch(() => undefined);
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (dbLock) await releaseLifecycleLock(prisma, JOB_ID, owner).catch(() => undefined);
    await prisma.$disconnect();
    await localLock.close().catch(() => undefined);
    await unlink(LOCK_PATH).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
