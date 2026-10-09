import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runtime = join(root, "runtime", "securities-lending");
const checkpointPath = join(runtime, "checkpoint.json");
const heartbeatPath = join(runtime, "heartbeat.json");
const manifestPath = join(runtime, "completion-manifest.json");
const logPath = join(runtime, "securities-lending.log");
const archiveDir = join(runtime, "archive");
const scheduler = JSON.parse(await readFile(join(root, "config", "securities-lending-scheduler.json"), "utf8"));
const prisma = new PrismaClient();
const once = process.argv.includes("--once");
const SOURCE_START = "2019-12-23";
const HISTORY_BATCH = 5;
let stopping = false;

await Promise.all([archiveDir, join(runtime, "data"), join(runtime, "retry")].map((p) => mkdir(p, { recursive: true })));
async function json(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
async function atomic(path, value) { const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, path); }
async function log(message) { await appendFile(logPath, `${new Date().toISOString()} pid=${process.pid} ${message}\n`); }
async function heartbeat(stage, scope, extra = {}) {
  const now = new Date().toISOString();
  const value = { asset: "GLOBAL_SECURITIES_LENDING", owner: "STANDALONE_SECURITIES_LENDING", pid: process.pid, processAlive: true, stage, scope, heartbeatAt: now, ...extra };
  await atomic(heartbeatPath, value);
  await atomic(checkpointPath, { ...(await json(checkpointPath, {})), ...value, updatedAt: now });
}
function isoDate(value) { return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`; }
function compactDate(value) { return value.replaceAll("-", ""); }
function previousDate(value) { const d = new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0,10); }
function number(value) { const n = Number(String(value ?? "").replaceAll(",", "")); return Number.isFinite(n) ? n : null; }

async function fetchTwse(requestedDate, stage) {
  await heartbeat(stage, `TWSE:${requestedDate ?? "LATEST"}`);
  const url = new URL("https://www.twse.com.tw/rwd/en/marginTrading/TWT93U");
  url.searchParams.set("response", "json");
  url.searchParams.set("selectType", "ALL");
  if (requestedDate) url.searchParams.set("date", compactDate(requestedDate));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), scheduler.request.timeoutSeconds * 1000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": scheduler.request.userAgent, accept: "application/json" } });
    if (!response.ok) throw new Error(`TWSE_HTTP_${response.status}`);
    const text = await response.text();
    const payload = JSON.parse(text);
    if (payload.stat !== "OK" || !/^\d{8}$/.test(payload.date) || !Array.isArray(payload.data)) throw new Error("TWSE_INVALID_PAYLOAD");
    const observationDate = isoDate(payload.date);
    const checksum = createHash("sha256").update(text).digest("hex");
    const archivePath = join(archiveDir, `twse-${payload.date}-${checksum.slice(0,16)}.json`);
    try { await readFile(archivePath); } catch { await writeFile(archivePath, text); }
    const stocks = await prisma.stock.findMany({ where: { exchange: "TWSE" }, select: { id: true, ticker: true } });
    const byTicker = new Map(stocks.map((stock) => [stock.ticker, stock.id]));
    const parsed = payload.data.map((row) => ({ ticker: String(row?.[0] ?? "").trim(), value: number(row?.[11]) })).filter((row) => row.ticker && row.value !== null);
    const matched = parsed.filter((row) => byTicker.has(row.ticker));
    let written = 0;
    for (const row of matched) {
      const stockId = byTicker.get(row.ticker);
      const sourceKey = createHash("sha256").update(`TWSE|${stockId}|${payload.date}|SECURITIES_BORROWING_BALANCE`).digest("hex");
      await prisma.$executeRawUnsafe(`INSERT INTO securities_lending_observations (id,stock_id,market,grain_type,observation_date,publication_date,metric_type,value,unit,source,source_url,source_record_id,retrieved_at,verification_status,freshness_status,publication_frequency,checksum,source_key,created_at,updated_at) VALUES ($1::uuid,$2,$3,'SECURITY_LEVEL',$4::date,$4::date,$5,$6,$7,$8,$9,$10,NOW(),'VERIFIED_OFFICIAL','CURRENT','DAILY',$11,$12,NOW(),NOW()) ON CONFLICT (stock_id,observation_date,metric_type) DO UPDATE SET value=EXCLUDED.value,unit=EXCLUDED.unit,source=EXCLUDED.source,source_url=EXCLUDED.source_url,source_record_id=EXCLUDED.source_record_id,retrieved_at=NOW(),verification_status='VERIFIED_OFFICIAL',freshness_status='CURRENT',checksum=EXCLUDED.checksum,updated_at=NOW()`, randomUUID(), stockId, "TWSE", observationDate, "SECURITIES_BORROWING_BALANCE", row.value, "SHARES", "TWSE Official TWT93U", "https://www.twse.com.tw/rwd/en/marginTrading/TWT93U", `${payload.date}:${row.ticker}:11`, checksum, sourceKey);
      written++;
      if (written % 100 === 0) await heartbeat(stage, `TWSE:${observationDate}`, { sourceRows: payload.data.length, parsedRows: parsed.length, matchedRows: matched.length, writtenRows: written });
    }
    const result = { market: "TWSE", requestedDate, observationDate, sourceRows: payload.data.length, parsedRows: parsed.length, matchedRows: matched.length, writtenRows: written, unmatchedRows: parsed.length - matched.length, checksum, archivePath, verificationStatus: "VERIFIED_OFFICIAL", qualityStatus: "PASS", metricCode: "SECURITIES_BORROWING_BALANCE", semantic: "borrowed securities sold outstanding balance" };
    await log(`${stage} ${JSON.stringify(result)}`);
    return result;
  } finally { clearTimeout(timer); }
}

async function coverage() {
  const rows = await prisma.$queryRawUnsafe(`SELECT market,metric_type,COUNT(*)::int records,COUNT(DISTINCT stock_id)::int entities,MIN(observation_date)::text first_observation_date,MAX(observation_date)::text latest_observation_date FROM securities_lending_observations GROUP BY market,metric_type ORDER BY market,metric_type`);
  const universe = await prisma.$queryRawUnsafe(`SELECT exchange AS market,COUNT(*)::int eligible_securities FROM stocks WHERE exchange IN ('ASX','JPX','LSE','NASDAQ','NYSE','TWSE') GROUP BY exchange ORDER BY exchange`);
  await atomic(join(runtime, "market-coverage.json"), { generatedAt: new Date().toISOString(), totalMeasurableSecurities: universe.reduce((sum, x) => sum + x.eligible_securities, 0), markets: universe, observations: rows });
  return { rows, universe };
}

async function cycle() {
  const cp = await json(checkpointPath, {});
  const latest = await fetchTwse(null, "LATEST");
  let cursor = cp.historical?.nextDate ?? previousDate(latest.observationDate);
  const historicalResults = [];
  for (let i = 0; i < HISTORY_BATCH && cursor >= SOURCE_START; i++) {
    try { historicalResults.push(await fetchTwse(cursor, "HISTORICAL")); }
    catch (error) { await log(`HISTORICAL TWSE date=${cursor} error=${String(error)}`); }
    cursor = previousDate(cursor);
  }
  const stats = await coverage();
  const now = new Date().toISOString();
  const historicalComplete = cursor < SOURCE_START;
  const current = await json(checkpointPath, {});
  await atomic(checkpointPath, { ...current, asset: "GLOBAL_SECURITIES_LENDING", owner: "STANDALONE_SECURITIES_LENDING", pid: process.pid, processAlive: true, stage: historicalComplete ? "SCHEDULED" : "HISTORICAL", scope: historicalComplete ? "incremental" : `TWSE:${cursor}`, latestCompletedAt: now, historical: { market: "TWSE", metric: "SECURITIES_BORROWING_BALANCE", nextDate: cursor, lastProcessedDate: historicalResults.at(-1)?.requestedDate ?? null, lastSuccessfulDate: historicalResults.at(-1)?.observationDate ?? null, rowsWritten: historicalResults.reduce((sum, x) => sum + x.writtenRows, 0), failureCount: HISTORY_BATCH - historicalResults.length, nextEligibleAt: new Date(Date.now() + (historicalComplete ? 86400000 : 60000)).toISOString(), complete: historicalComplete }, updatedAt: now });
  await atomic(manifestPath, { asset: "GLOBAL_SECURITIES_LENDING", generatedAt: now, owner: "STANDALONE_SECURITIES_LENDING", pid: process.pid, processAlive: true, schedulerActive: true, historicalComplete, productionComplete: false, latest, historicalBatch: historicalResults, observationDomains: stats.rows, autoContinuing: !once });
  await log(`cycle-complete latestWritten=${latest.writtenRows} historyDates=${historicalResults.length} historicalComplete=${historicalComplete}`);
  return historicalComplete;
}

async function stop(signal) { if (stopping) return; stopping = true; await atomic(heartbeatPath, { asset: "GLOBAL_SECURITIES_LENDING", owner: "STANDALONE_SECURITIES_LENDING", pid: process.pid, processAlive: false, stage: "STOPPED", scope: signal, heartbeatAt: new Date().toISOString() }); await prisma.$disconnect(); process.exit(0); }
process.on("SIGTERM", () => void stop("SIGTERM")); process.on("SIGINT", () => void stop("SIGINT"));
process.on("uncaughtException", async (error) => { await log(`fatal uncaughtException=${String(error?.stack ?? error)}`); await stop("UNCAUGHT_EXCEPTION"); });
process.on("unhandledRejection", async (error) => { await log(`fatal unhandledRejection=${String(error)}`); await stop("UNHANDLED_REJECTION"); });
await log("runner-started owner=STANDALONE_SECURITIES_LENDING");
do {
  try { const complete = await cycle(); if (!once) await new Promise((resolve) => setTimeout(resolve, complete ? scheduler.incrementalIntervalMinutes * 60000 : 60000)); }
  catch (error) { await log(`cycle-failed error=${String(error?.stack ?? error)}`); await atomic(heartbeatPath, { asset: "GLOBAL_SECURITIES_LENDING", owner: "STANDALONE_SECURITIES_LENDING", pid: process.pid, processAlive: true, stage: "RETRY", scope: "cycle", heartbeatAt: new Date().toISOString(), lastError: String(error), nextEligibleAt: new Date(Date.now() + 60000).toISOString() }); if (once) throw error; await new Promise((resolve) => setTimeout(resolve, 60000)); }
} while (!once && !stopping);
await prisma.$disconnect();
