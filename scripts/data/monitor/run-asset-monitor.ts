import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNTIME = join(ROOT, "runtime");
const OUTPUT = join(RUNTIME, "monitor");
const THIRTY_MINUTES = 30 * 60 * 1000;
const SIXTY_MINUTES = 60 * 60 * 1000;
const ALWAYS_HEALTHY_STAGES = new Set([
  "HISTORICAL",
  "HISTORICAL_ARCHIVE",
  "LATEST",
  "LATEST_INCREMENTAL",
  "LATEST_INCREMENTAL_SLEEP",
  "SCHEDULED",
  "SCHEDULED_INCREMENTAL",
  "WAITING_NEXT_BATCH",
  "WAITING_NEXT_SOURCE",
  "WAITING_DATABASE_RECOVERY",
  "ARCHIVING",
]);

const ASSETS = [
  ["Global Stock", "historical"],
  ["ETF", "etf"],
  ["Bond", "bond"],
  ["Government Yield", "government-yield"],
  ["Economic", "economic"],
  ["Commodity", "commodity"],
  ["Global FX", "fx"],
  ["Global Crypto", "crypto"],
  ["Global Index", "index"],
  ["Global Volatility Index", "volatility"],
  ["Global Dollar/Currency Index", "currency-index"],
  ["Global Interest Rate Futures", "interest-futures"],
  ["Global Credit Spread", "credit-spread"],
] as const;

type Json = Record<string, unknown>;

function filesAt(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name));
}

function matching(files: string[], pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(file.split(/[\\/]/).at(-1) ?? ""));
}

function newest(files: string[]): string | undefined {
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function readJson(file?: string): Json | undefined {
  if (!file) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value as Json : undefined;
  } catch { return undefined; }
}

function deepFind(value: unknown, keys: RegExp): unknown {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (keys.test(key)) return child;
  }
  for (const child of Object.values(value)) {
    const found = deepFind(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function numberValue(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function processAlive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function csv(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const now = Date.now();
const rows = ASSETS.map(([asset, folder]) => {
  const dir = join(RUNTIME, folder);
  const files = filesAt(dir);
  const checkpointFile = newest(matching(files, /^checkpoint.*\.json$/i));
  const heartbeatFile = newest(matching(files, /^heartbeat.*\.json$/i));
  const manifestFile = newest(matching(files, /^completion-manifest.*\.json$/i));
  const failureFiles = matching(files, /^(failure-queue|dead-letter).*\.json$/i);
  const logFiles = matching(files, /\.log$/i);
  const checkpoint = readJson(checkpointFile);
  const heartbeat = readJson(heartbeatFile);
  const manifest = readJson(manifestFile);
  const evidence = [heartbeat, checkpoint, manifest].filter(Boolean);
  const pidRaw = evidence.map((item) => deepFind(item, /^pid$|processId/i)).find((v) => v !== undefined);
  const pid = Number.isInteger(Number(pidRaw)) && Number(pidRaw) > 0 ? Number(pidRaw) : null;
  const alive = processAlive(pid);
  const stage = evidence.map((item) => deepFind(item, /^(current)?stage$|phase/i)).find((v) => v !== undefined);
  const scope = evidence.map((item) => deepFind(item, /^(current)?scope$|symbol|market|batch/i)).find((v) => v !== undefined);
  const checkpointValue = checkpoint ? deepFind(checkpoint, /cursor|checkpoint|offset|page|index|lastProcessed/i) : undefined;
  const structuredProgress = evidence.map((item) => deepFind(item, /lastProgress|updatedAt|heartbeatAt|timestamp/i)).map(iso).find(Boolean) ?? null;
  let logProgress: string | null = null;
  let logErrors = 0;
  for (const file of logFiles) {
    const tail = readFileSync(file, "utf8").split(/\r?\n/).slice(-20);
    logErrors += tail.filter((line) => /\b(error|failed|failure|exception|fatal)\b/i.test(line)).length;
    for (const line of tail.reverse()) {
      const stamp = line.match(/\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?/i)?.[0];
      const parsed = iso(stamp);
      if (parsed && (!logProgress || parsed > logProgress)) logProgress = parsed;
    }
  }
  const lastProgressAt = [structuredProgress, logProgress].filter(Boolean).sort().at(-1) ?? null;
  const recent = lastProgressAt ? now - new Date(lastProgressAt).valueOf() <= THIRTY_MINUTES : false;
  const failures = failureFiles.reduce((sum, file) => sum + numberValue(readJson(file) ? deepFind(readJson(file), /items|failures|entries|queue|count/i) : 0), 0) + logErrors;
  const retry = evidence.reduce((sum, item) => sum + numberValue(deepFind(item, /retryCount|retries|attempt/i)), 0);
  const completeValue = manifest && deepFind(manifest, /complete|completed|status/i);
  const complete = completeValue === true || /^(complete|completed|success|succeeded)$/i.test(String(completeValue ?? ""));
  const autoValue = evidence.map((item) => deepFind(item, /autoContinu|resume|continuing/i)).find((v) => v !== undefined);
  const autoContinuing = autoValue === true || /^(true|yes|enabled|running)$/i.test(String(autoValue ?? ""));
  const normalizedStage = String(stage ?? "").trim().toUpperCase();
  const checkpointUpdatedAt = checkpointFile ? statSync(checkpointFile).mtimeMs : null;
  const checkpointStale = checkpointUpdatedAt !== null && now - checkpointUpdatedAt > SIXTY_MINUTES;
  const unconditionalHealthyStage = ALWAYS_HEALTHY_STAGES.has(normalizedStage);
  const continuingHealthyStage = /^(RETRY|BACKOFF)$/.test(normalizedStage) && autoContinuing;
  let status = "UNKNOWN";
  if (complete) status = "COMPLETE";
  else if (files.length > 0 && !alive) status = "STOPPED";
  else if (alive && checkpointStale) status = "WARNING";
  else if (alive && (unconditionalHealthyStage || continuingHealthyStage)) status = "HEALTHY";
  else if (alive && !autoContinuing) status = "WARNING";
  else if (alive && autoContinuing) status = "HEALTHY";
  const logUpdatedAt = logFiles.length ? new Date(Math.max(...logFiles.map((file) => statSync(file).mtimeMs))).toISOString() : null;
  return {
    ASSET: asset, STATUS: status, PID: pid, PROCESS_ALIVE: alive ? "YES" : "NO",
    CURRENT_STAGE: stage ?? null, CURRENT_SCOPE: scope ?? null, CHECKPOINT: checkpointValue ?? null,
    LAST_PROGRESS_AT: lastProgressAt, LAST_30_MIN_PROGRESS: recent ? "YES" : "NO",
    FAILURES: failures, RETRY: retry, AUTO_CONTINUING: autoContinuing ? "YES" : "NO",
    LOG_UPDATED_AT: logUpdatedAt,
    STORAGE: {
      DATABASE: "NOT_ACCESSED",
      ARCHIVE: files.some((file) => /archive/i.test(file)) ? "PRESENT" : "UNKNOWN",
      STAGING: files.some((file) => /staging/i.test(file)) ? "PRESENT" : "UNKNOWN",
    },
  };
});

mkdirSync(OUTPUT, { recursive: true });
const jsonPath = join(OUTPUT, "asset-status.json");
const csvPath = join(OUTPUT, "asset-status.csv");
const monitorLog = join(OUTPUT, "asset-monitor.log");
writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), readOnly: true, assets: rows }, null, 2) + "\n");
const headers = Object.keys(rows[0]).filter((key) => key !== "STORAGE");
writeFileSync(csvPath, [headers.map(csv).join(","), ...rows.map((row) => headers.map((key) => csv(row[key as keyof typeof row])).join(","))].join("\n") + "\n");
writeFileSync(monitorLog, `${new Date().toISOString()} monitor completed; assets=${rows.length}\n`);
console.table(rows.map(({ STORAGE: _storage, ...row }) => row));
