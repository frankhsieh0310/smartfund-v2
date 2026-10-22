const { spawn } = require("node:child_process");
const { open, readFile, rename, mkdir, writeFile } = require("node:fs/promises");
const { appendFileSync } = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");

const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, "runtime", "automation", "jpx-standalone");
const FILES = {
  lock: path.join(RUNTIME, "runner.lock.json"),
  pid: path.join(RUNTIME, "pid.json"),
  queue: path.join(RUNTIME, "queue.json"),
  state: path.join(RUNTIME, "checkpoint.json"),
  failures: path.join(RUNTIME, "failure-queue.json"),
  heartbeat: path.join(RUNTIME, "heartbeat.json"),
  manifest: path.join(RUNTIME, "completion-manifest.json"),
  stdout: path.join(RUNTIME, "runner.stdout.log"),
  stderr: path.join(RUNTIME, "runner.stderr.log"),
};
const HISTORICAL = path.join(ROOT, "scripts", "data", "historical", "run-production-jpx-historical.ts");
const MAX_SYMBOLS = 25;
const MAX_CONSECUTIVE_RETRIES = 12;
const RETRY_DELAY_MS = 5 * 60_000;
const COLLISION_DELAY_MS = 5 * 60_000;
const CHILD_OUTPUT_LIMIT = 4 * 1024 * 1024;
const OWNER = `jpx-standalone:${process.pid}`;

function prismaClient() {
  const raw = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL_REQUIRED:launch with --env-file=.env");
  const url = new URL(raw);
  if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "1");
  if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "20");
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

let stopping = false;
let lockHandle = null;
let heartbeatTimer = null;
let state = {
  version: 1,
  status: "STARTING",
  owner: OWNER,
  market: "JPX",
  layer: "L3_HISTORICAL_DAILY_PRICE",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  batchesCompleted: 0,
  consecutiveRetries: 0,
  lastCheckpoint: { lastSymbol: "456A", processed: 1368, succeeded: 1319, failed: 49, rows: 5509307 },
  lastError: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function durableOutput(file, chunk) {
  try { appendFileSync(file, chunk); } catch {}
}

async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function persistState(patch = {}) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  await atomicJson(FILES.state, state);
}

async function heartbeat() {
  await atomicJson(FILES.heartbeat, {
    pid: process.pid,
    owner: OWNER,
    status: state.status,
    market: state.market,
    layer: state.layer,
    checkpoint: state.lastCheckpoint,
    consecutiveRetries: state.consecutiveRetries,
    updatedAt: new Date().toISOString(),
  });
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireFileLock() {
  await mkdir(RUNTIME, { recursive: true });
  try {
    lockHandle = await open(FILES.lock, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readJson(FILES.lock, null);
    if (existing && pidAlive(existing.pid)) throw new Error(`DUPLICATE_STANDALONE_OWNER:${existing.pid}`);
    await rename(FILES.lock, `${FILES.lock}.stale.${Date.now()}`);
    lockHandle = await open(FILES.lock, "wx");
  }
  await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, owner: OWNER, startedAt: new Date().toISOString() }, null, 2)}\n`);
  await lockHandle.sync();
}

async function releaseFileLock() {
  if (!lockHandle) return;
  await lockHandle.close().catch(() => {});
  lockHandle = null;
  await rename(FILES.lock, `${FILES.lock}.released.${Date.now()}`).catch(() => {});
}

function runChild(args, live) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--env-file=.env", HISTORICAL, ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        SMARTFUND_NODE_ID: OWNER,
        ...(live ? { LIVE_WRITE_AUTHORIZED: "true" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => {
      durableOutput(FILES.stdout, chunk);
      if (stdout.length < CHILD_OUTPUT_LIMIT) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      durableOutput(FILES.stderr, chunk);
      if (stderr.length < CHILD_OUTPUT_LIMIT) stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}\n${error.stack ?? error.message}` }));
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function plannedSymbols(stdout) {
  const match = stdout.match(/"plannedSymbols"\s*:\s*(\[[\s\S]*?\])/);
  if (!match) return [];
  try { return JSON.parse(match[1]); } catch { return []; }
}

function latestCheckpoint(output, fallback) {
  const lines = output.split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (value.status === "PAUSED_CHECKPOINTED") {
        return { lastSymbol: value.checkpoint, processed: value.attempted, succeeded: value.completed, failed: value.failed, rows: value.inserted };
      }
      if (value.status === "COMPLETE" && value.ticker) {
        return { ...fallback, lastSymbol: value.ticker, processed: value.processed };
      }
    } catch {}
  }
  return fallback;
}

async function validatePlan(symbols) {
  if (symbols.length < 1 || symbols.length > MAX_SYMBOLS || new Set(symbols).size !== symbols.length) {
    throw new Error(`INVALID_PLANNED_SYMBOLS:${symbols.length}`);
  }
  const prisma = prismaClient();
  try {
    const stocks = await prisma.stock.findMany({
      where: { ticker: { in: symbols }, exchange: "JPX", isActive: true, status: "ACTIVE" },
      select: { id: true, ticker: true, yahooSymbol: true },
    });
    const sourceSymbols = stocks.map((stock) => stock.yahooSymbol);
    const now = new Date();
    const jobs = ["stock-price-jpx-historical", "japan-yahoo-daily"];
    const [etfs, funds, assets, locks, runs] = await Promise.all([
      prisma.etf.count({ where: { code: { in: sourceSymbols } } }),
      prisma.fund.count({ where: { code: { in: sourceSymbols } } }),
      prisma.asset.count({ where: { code: { in: sourceSymbols } } }),
      prisma.productionSchedulerLock.count({ where: { jobId: { in: jobs }, expiresAt: { gt: now } } }),
      prisma.productionSchedulerRun.count({ where: { jobId: { in: jobs }, status: { in: ["RUNNING", "IN_PROGRESS", "PAUSE_REQUESTED"] } } }),
    ]);
    if (stocks.length !== symbols.length || new Set(stocks.map((stock) => stock.id)).size !== symbols.length) throw new Error("JPX_STOCK_ID_SCOPE_MISMATCH");
    if (etfs || funds || assets) throw new Error(`CROSS_DOMAIN_SOURCE_SYMBOL_OVERLAP:${etfs}/${funds}/${assets}`);
    if (locks || runs) throw new Error(`ACTIVE_DB_COLLISION:${locks}/${runs}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function synchronizeAuthoritativeCheckpoint() {
  const prisma = prismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT c.last_symbol, c.processed, c.succeeded, c.failed, r.details FROM production_scheduler_checkpoints c LEFT JOIN production_scheduler_runs r ON r.id = c.run_id WHERE c.job_id = $1 ORDER BY c.updated_at DESC LIMIT 1",
      "stock-price-jpx-historical",
    );
    const checkpoint = rows[0];
    if (!checkpoint) return;
    const details = checkpoint.details && typeof checkpoint.details === "object" ? checkpoint.details : {};
    const authoritative = {
      lastSymbol: checkpoint.last_symbol,
      processed: Number(checkpoint.processed ?? 0),
      succeeded: Number(checkpoint.succeeded ?? 0),
      failed: Number(checkpoint.failed ?? 0),
      rows: Number(details.inserted ?? state.lastCheckpoint.rows ?? 0),
    };
    if (authoritative.processed >= Number(state.lastCheckpoint.processed ?? 0)) {
      state.lastCheckpoint = authoritative;
      await persistState({ lastCheckpoint: authoritative, checkpointSource: "DATABASE" });
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function recordFailure(error) {
  const failures = await readJson(FILES.failures, []);
  failures.push({ at: new Date().toISOString(), error: error.stack ?? error.message ?? String(error), retry: state.consecutiveRetries });
  await atomicJson(FILES.failures, failures.slice(-200));
}

async function complete(status, reason = null) {
  await persistState({ status, completedAt: new Date().toISOString(), lastError: reason });
  await heartbeat();
  await atomicJson(FILES.manifest, {
    market: "JPX",
    layer: "L3_HISTORICAL_DAILY_PRICE",
    status,
    historicalLocked: status === "COMPLETED",
    checkpoint: state.lastCheckpoint,
    batchesCompleted: state.batchesCompleted,
    failureQueuePath: FILES.failures,
    reason,
    completedAt: new Date().toISOString(),
  });
}

async function main() {
  await acquireFileLock();
  await atomicJson(FILES.pid, {
    pid: process.pid,
    owner: OWNER,
    command: process.argv.join(" "),
    checkpointPath: FILES.state,
    logPath: FILES.stdout,
    startedAt: new Date().toISOString(),
  });
  durableOutput(FILES.stdout, `${JSON.stringify({ event: "STANDALONE_START", pid: process.pid, owner: OWNER, at: new Date().toISOString() })}\n`);
  const previous = await readJson(FILES.state, null);
  if (previous && previous.status !== "COMPLETED") state = {
    ...state,
    ...previous,
    owner: OWNER,
    status: "STARTING",
    consecutiveRetries: 0,
    completedAt: null,
    updatedAt: new Date().toISOString(),
  };
  await atomicJson(FILES.queue, [{ id: "jpx-l3-historical", market: "JPX", layer: "L3", status: "QUEUED", maxSymbols: MAX_SYMBOLS }]);
  await persistState();
  await synchronizeAuthoritativeCheckpoint();
  await heartbeat();
  heartbeatTimer = setInterval(() => heartbeat().catch((error) => durableOutput(FILES.stderr, `${error.stack ?? error}\n`)), 30_000);

  while (!stopping) {
    try {
      await persistState({ status: "DRY_RUN", lastError: null });
      const dry = await runChild(["--market=JPX", `--max-symbols=${MAX_SYMBOLS}`, "--dry-run"], false);
      if (dry.code !== 0) throw new Error(`DRY_RUN_FAILED:${dry.stderr.slice(-1000)}`);
      if (!dry.stdout.includes("DRY_RUN_READY") || !dry.stdout.includes('"writesPerformed": false')) throw new Error("DRY_RUN_NOT_READY");
      const symbols = plannedSymbols(dry.stdout);
      if (symbols.length === 0) {
        if (dry.stdout.includes('"plannedCount": 0')) { await complete("COMPLETED"); return; }
        throw new Error("DRY_RUN_PLAN_PARSE_FAILED");
      }
      await validatePlan(symbols);
      await persistState({ status: "RUNNING_BATCH", plannedSymbols: symbols, consecutiveRetries: 0 });
      const live = await runChild(["--market=JPX", `--max-symbols=${MAX_SYMBOLS}`], true);
      if (live.code !== 0) throw new Error(`LIVE_BATCH_FAILED:${live.stderr.slice(-1000)}`);
      state.lastCheckpoint = latestCheckpoint(live.stdout, state.lastCheckpoint);
      state.batchesCompleted += 1;
      await persistState({ status: "BATCH_COMPLETE", lastCheckpoint: state.lastCheckpoint, batchesCompleted: state.batchesCompleted, plannedSymbols: [] });
      if (/"remaining"\s*:\s*0/.test(live.stdout) && /"status"\s*:\s*"PASS"/.test(live.stdout)) { await complete("COMPLETED"); return; }
      if (live.stdout.includes("PAUSED_DAILY_COLLISION")) await sleep(COLLISION_DELAY_MS);
      else await sleep(5_000);
    } catch (error) {
      state.consecutiveRetries += 1;
      await recordFailure(error);
      await persistState({ status: "RETRY_WAIT", consecutiveRetries: state.consecutiveRetries, lastError: error.message ?? String(error) });
      if (state.consecutiveRetries >= MAX_CONSECUTIVE_RETRIES) {
        await complete("BLOCKED_RETRY_EXHAUSTED", error.message ?? String(error));
        process.exitCode = 2;
        return;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  await complete("STOPPED_BY_SIGNAL", "PROCESS_SIGNAL");
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });

main()
  .catch(async (error) => {
    console.error(error.stack ?? error);
    await recordFailure(error).catch(() => {});
    await complete("CRASHED", error.stack ?? error.message ?? String(error)).catch(() => {});
    durableOutput(FILES.stderr, `${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await releaseFileLock();
  });
