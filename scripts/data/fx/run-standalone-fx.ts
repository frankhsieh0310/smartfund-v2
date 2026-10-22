import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { buildFxPairs, loadFxConfig } from "./fx-config.ts";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";

type Work = { key: string; pair: string; providerSymbol: string; interval: string; mode: "HISTORICAL" | "INCREMENTAL"; attempts: number; nextRunAt: string };
type Checkpoint = { version: 1; stage: string; current: string | null; completed: Record<string, string>; retry: Work[]; deadLetter: Array<Work & { error: string }>; cycles: number; updatedAt: string };
type Quote = { open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> };
type Row = { pair: string; interval: string; openTime: string; closeTime: string; open: number; high: number; low: number; close: number; mid: number; volume: number | null; source: string; sourceUrl: string; lineage: { providerInterval: string; fetchedAt: string; derived: boolean } };

const root = resolve("runtime", "fx");
const checkpointPath = resolve(root, "checkpoint.json");
const heartbeatPath = resolve(root, "heartbeat.json");
const manifestPath = resolve(root, "completion-manifest.json");
const missingPath = resolve(root, "missing-matrix.json");
const lockPath = resolve(root, "standalone.lock");
const logPath = resolve(root, "standalone.log");
const derivedHours: Record<string, number> = { "2h": 2, "4h": 4, "6h": 6, "12h": 12 };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function atomic(path: string, value: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value);
  const retryable = (error: unknown) => error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      lastError = error;
      if (!retryable(error)) throw error;
      await sleep(Math.min(400, 25 * 2 ** attempt));
    }
  }
  // The original checkpoint remains untouched when all bounded replace
  // attempts fail. The temp file is intentionally retained for diagnosis.
  throw lastError;
}

async function log(event: Record<string, unknown>) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
  const handle = await open(logPath, "a");
  try { await handle.write(line); } finally { await handle.close(); }
}

async function loadCheckpoint(): Promise<Checkpoint> {
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
    const retryByKey = new Map(checkpoint.retry.map((item) => [item.key, item]));
    const permanentByKey = new Map<string, Checkpoint["deadLetter"][number]>();
    for (const item of checkpoint.deadLetter) {
      if (/fetch failed|HTTP_429|timeout|ECONN|network/i.test(item.error)) {
        if (!retryByKey.has(item.key)) retryByKey.set(item.key, { ...item, attempts: 0, nextRunAt: new Date().toISOString() });
      } else permanentByKey.set(item.key, item);
    }
    checkpoint.retry = [...retryByKey.values()];
    checkpoint.deadLetter = [...permanentByKey.values()];
    return checkpoint;
  }
  catch { return { version: 1, stage: "HISTORICAL", current: null, completed: {}, retry: [], deadLetter: [], cycles: 0, updatedAt: new Date().toISOString() }; }
}

async function saveCheckpoint(checkpoint: Checkpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  await atomic(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function acquireLock() {
  await mkdir(root, { recursive: true });
  try {
    const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    if (existing.pid && alive(existing.pid)) throw new Error(`FX_STANDALONE_ALREADY_RUNNING:${existing.pid}`);
    await unlink(lockPath).catch(() => undefined);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("FX_STANDALONE_ALREADY_RUNNING")) throw error;
  }
  const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  await handle.write(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
  await handle.close();
}

function providerInterval(interval: string) { return derivedHours[interval] ? "60m" : interval; }
function range(interval: string, mode: Work["mode"]) {
  if (mode === "INCREMENTAL") return ["1d", "1wk", "1mo"].includes(interval) ? "10d" : "2d";
  if (["1d", "1wk", "1mo"].includes(interval)) return "max";
  return interval === "1m" ? "7d" : "60d";
}

async function fetchRows(work: Work): Promise<Row[]> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(work.providerSymbol)}`);
  url.searchParams.set("interval", providerInterval(work.interval));
  url.searchParams.set("range", range(work.interval, work.mode));
  url.searchParams.set("events", "history");
  const response = await fetch(url, { headers: { "user-agent": "SmartFund-FX-Standalone/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const body = await response.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Quote[] } }>; error?: unknown } };
  const result = body.chart?.result?.[0];
  if (!result) throw new Error(`EMPTY_PROVIDER_RESULT:${JSON.stringify(body.chart?.error ?? null)}`);
  const quote = result.indicators?.quote?.[0];
  const fetchedAt = new Date().toISOString();
  const raw = (result.timestamp ?? []).flatMap((epoch, index): Row[] => {
    const openValue = quote?.open?.[index], high = quote?.high?.[index], low = quote?.low?.[index], close = quote?.close?.[index];
    if (openValue == null || high == null || low == null || close == null) return [];
    const seconds = providerInterval(work.interval) === "60m" ? 3_600 : 86_400;
    return [{ pair: work.pair, interval: work.interval, openTime: new Date(epoch * 1000).toISOString(), closeTime: new Date((result.timestamp?.[index + 1] ?? epoch + seconds) * 1000).toISOString(), open: openValue, high, low, close, mid: close, volume: quote?.volume?.[index] ?? null, source: "YAHOO_CHART", sourceUrl: url.toString(), lineage: { providerInterval: providerInterval(work.interval), fetchedAt, derived: Boolean(derivedHours[work.interval]) } }];
  });
  if (!derivedHours[work.interval]) return raw;
  const bucketSeconds = derivedHours[work.interval] * 3_600;
  return [...raw.reduce((groups, row) => {
    const bucket = Math.floor(Date.parse(row.openTime) / 1000 / bucketSeconds) * bucketSeconds;
    const current = groups.get(bucket);
    if (!current) groups.set(bucket, { ...row, openTime: new Date(bucket * 1000).toISOString(), closeTime: new Date((bucket + bucketSeconds) * 1000).toISOString() });
    else groups.set(bucket, { ...current, high: Math.max(current.high, row.high), low: Math.min(current.low, row.low), close: row.close, mid: row.close, volume: current.volume == null && row.volume == null ? null : (current.volume ?? 0) + (row.volume ?? 0) });
    return groups;
  }, new Map<number, Row>()).values()];
}

async function archive(work: Work, rows: Row[]) {
  const folder = resolve(root, "archive", work.mode.toLowerCase(), work.interval);
  const path = resolve(folder, `${work.pair}.json.gz`);
  await atomic(path, gzipSync(JSON.stringify({ version: 1, work, rows })));
  return { path, rows: rows.length, first: rows[0]?.openTime ?? null, last: rows.at(-1)?.openTime ?? null };
}

async function heartbeat(checkpoint: Checkpoint) {
  await atomic(heartbeatPath, `${JSON.stringify({ pid: process.pid, alive: true, stage: checkpoint.stage, current: checkpoint.current, checkpointAt: checkpoint.updatedAt, heartbeatAt: new Date().toISOString() }, null, 2)}\n`);
}

async function publishStatus(checkpoint: Checkpoint, input: { work?: Work; rows?: number; runState?: "RUNNING" | "SCHEDULED_WAIT" | "BLOCKED"; nextRunAt?: string | null; blocker?: string | null; progress?: string }) {
  const work = input.work;
  const processed = Object.keys(checkpoint.completed).length;
  const total = work ? 528 * 12 : null;
  await writeAssetRuntimeStatus({
    ASSET: "FX", CURRENT_PHASE: checkpoint.stage, CURRENT_LAYER: work?.mode === "HISTORICAL" ? (work.interval === "1d" ? "Daily" : "Intraday") : input.runState === "SCHEDULED_WAIT" ? "Scheduler" : "Incremental",
    CURRENT_TASK: work?.mode === "HISTORICAL" ? "Historical" : input.runState === "SCHEDULED_WAIT" ? "Scheduler" : "Incremental", CURRENT_MARKET: "GLOBAL", CURRENT_PAIR: work?.pair ?? null,
    CURRENT_BASE_CURRENCY: work?.pair.slice(0, 3) ?? null, CURRENT_QUOTE_CURRENCY: work?.pair.slice(3, 6) ?? null, CURRENT_SOURCE: work ? "YAHOO_CHART" : null,
    PROCESSED: processed, TOTAL: total, COVERAGE: total ? `${((processed / total) * 100).toFixed(1)}%` : null, RUN_STATE: input.runState ?? "RUNNING", PROCESS_ID: process.pid,
    CHECKPOINT: checkpoint.current, BLOCKER: input.blocker ?? null, NEXT: input.runState === "SCHEDULED_WAIT" ? "Resume next incremental FX cycle" : "Process next checkpointed currency pair", NEXT_RUN_AT: input.nextRunAt ?? null,
    QUOTE_STATUS: "NOT_READY", CONTINUING: input.blocker ? "NO" : "YES", LAST_PROGRESS: input.progress, progressChanged: Boolean(input.progress),
  });
}

async function main() {
  await acquireLock();
  const config = await loadFxConfig();
  const pairs = buildFxPairs(config);
  const checkpoint = await loadCheckpoint();
  await atomic(missingPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), policy: "NO_INTERPOLATION", unavailableUntilSourceProvides: ["TICK", "BID", "ASK", "SPREAD"], reason: "YAHOO_CHART_DOES_NOT_PUBLISH_THESE_FIELDS;_OFFICIAL_SOURCE_ADAPTERS_REMAIN_SEPARATE" }, null, 2)}\n`);
  for (;;) {
    const mode: Work["mode"] = checkpoint.stage === "HISTORICAL" ? "HISTORICAL" : "INCREMENTAL";
    const now = Date.now();
    const fresh = pairs.flatMap((pair) => config.intervals.map((interval): Work => ({ key: `${mode}:${pair.symbol}:${interval}`, pair: pair.symbol, providerSymbol: pair.providerSymbol, interval, mode, attempts: 0, nextRunAt: new Date(0).toISOString() })));
    const pending = [...checkpoint.retry.filter((item) => Date.parse(item.nextRunAt) <= now), ...fresh.filter((item) => !checkpoint.completed[item.key] && !checkpoint.retry.some((retry) => retry.key === item.key) && !checkpoint.deadLetter.some((dead) => dead.key === item.key))];
    if (pending.length === 0) {
      if (mode === "HISTORICAL") { checkpoint.stage = "INCREMENTAL"; checkpoint.completed = {}; checkpoint.retry = []; await saveCheckpoint(checkpoint); continue; }
      checkpoint.cycles += 1; checkpoint.completed = {}; await saveCheckpoint(checkpoint); await heartbeat(checkpoint); await publishStatus(checkpoint, { runState: "SCHEDULED_WAIT", nextRunAt: new Date(Date.now() + 15 * 60_000).toISOString(), progress: `Incremental cycle ${checkpoint.cycles} completed; next cycle scheduled` }); await sleep(15 * 60_000); continue;
    }
    for (const work of pending.slice(0, 10)) {
      checkpoint.current = work.key; await saveCheckpoint(checkpoint); await heartbeat(checkpoint); await publishStatus(checkpoint, { work });
      try {
        const result = await archive(work, await fetchRows(work));
        checkpoint.completed[work.key] = new Date().toISOString();
        checkpoint.retry = checkpoint.retry.filter((item) => item.key !== work.key);
        await log({ status: "ARCHIVED", key: work.key, ...result });
        await publishStatus(checkpoint, { work, rows: result.rows, progress: `${work.mode} ${work.pair} ${work.interval}: +${result.rows.toLocaleString()} rows archived; ${Object.keys(checkpoint.completed).length}/${pairs.length * config.intervals.length} processed` });
      } catch (error) {
        const attempts = work.attempts + 1;
        checkpoint.retry = checkpoint.retry.filter((item) => item.key !== work.key);
        if (attempts >= 8) checkpoint.deadLetter.push({ ...work, attempts, error: error instanceof Error ? error.message : String(error) });
        else checkpoint.retry.push({ ...work, attempts, nextRunAt: new Date(Date.now() + Math.min(6 * 60 * 60_000, 30_000 * 2 ** attempts)).toISOString() });
        await log({ status: attempts >= 8 ? "DEAD_LETTER" : "RETRY_QUEUED", key: work.key, attempts, error: error instanceof Error ? error.message : String(error) });
      }
      await saveCheckpoint(checkpoint); await sleep(350);
    }
    await atomic(manifestPath, `${JSON.stringify({ pid: process.pid, stage: checkpoint.stage, universe: { currencies: config.currencies.length, pairs: pairs.length, intervals: config.intervals.length }, completed: Object.keys(checkpoint.completed).length, retry: checkpoint.retry.length, deadLetter: checkpoint.deadLetter.length, updatedAt: checkpoint.updatedAt }, null, 2)}\n`);
  }
}

main().catch(async (error) => { await log({ status: "FATAL", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined); process.exitCode = 1; });
