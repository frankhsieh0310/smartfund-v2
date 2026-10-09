import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";

const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, "runtime", "commodity", "usgs-minerals");
const CHECKPOINT = path.join(RUNTIME, "checkpoint.json");
const HEARTBEAT = path.join(RUNTIME, "heartbeat.json");
const CONFIG_PATH = path.join(ROOT, "config", "usgs-minerals-bootstrap.json");
const isCanary = process.argv.includes("--canary");
const isOnce = process.argv.includes("--once") || isCanary;

type Config = {
  source: string; dataset: string; landingPage: string;
  canary: { commodity: string; workbookUrl: string; publicationAsOf: string; maxObservations: number };
  canonicalTargets: Array<{ identity: string; label: string }>;
  metrics: string[];
  batch: { maxObservations: number; maxDbConcurrency: number };
  schedule: { successDelayMs: number; retryDelayMs: number };
};
type Checkpoint = { targetIndex: number; rowIndex: number; metricIndex: number; observationsPersisted: number; updatedAt: string; lastError: string | null; state: string };

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
async function loadCheckpoint(): Promise<Checkpoint> {
  try { return JSON.parse(await readFile(CHECKPOINT, "utf8")); }
  catch { return { targetIndex: 0, rowIndex: 0, metricIndex: 0, observationsPersisted: 0, updatedAt: new Date().toISOString(), lastError: null, state: "READY" }; }
}
async function waitForNextCycle(config: Config, cp: Checkpoint) {
  const nextRunAt = new Date(Date.now() + config.schedule.successDelayMs).toISOString();
  while (Date.now() < Date.parse(nextRunAt)) {
    await atomicJson(HEARTBEAT, {
      source: config.source,
      pid: process.pid,
      state: "HEALTHY_WAITING",
      lastSuccessAt: cp.updatedAt,
      nextRunAt,
      checkpoint: CHECKPOINT,
      updatedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, Date.parse(nextRunAt) - Date.now())));
  }
}
async function fetchBuffer(url: string) {
  const response = await fetch(url, { headers: { "user-agent": "SmartFund-USGS-Minerals/1.0" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`USGS_HTTP_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
function rowsFromWorkbook(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, blankrows: false });
  const headerIndex = rows.findIndex((row) => row[0] === "Year");
  if (headerIndex < 0) throw new Error("USGS_HEADER_NOT_FOUND");
  return { headers: rows[headerIndex].map(String), rows: rows.slice(headerIndex + 1).filter((row) => Number.isFinite(Number(row[0]))) };
}
async function resolveWorkbookUrl(config: Config, label: string) {
  if (label === "Copper") return config.canary.workbookUrl;
  const listing = await (await fetch(config.landingPage, { signal: AbortSignal.timeout(60_000) })).text();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const media = listing.match(new RegExp(`<a[^>]+href="([^"]+)"[^>]*>\\s*${escaped}\\s*</a>`, "i"))?.[1];
  if (!media) throw new Error(`USGS_MEDIA_PAGE_NOT_FOUND:${label}`);
  const mediaUrl = new URL(media, config.landingPage).toString();
  const page = await (await fetch(mediaUrl, { signal: AbortSignal.timeout(60_000) })).text();
  const xlsx = page.match(/https?:[^"']+\.xlsx/i)?.[0]?.replaceAll("&amp;", "&");
  if (!xlsx) throw new Error(`USGS_XLSX_NOT_FOUND:${label}`);
  return xlsx;
}
async function persist(prisma: PrismaClient, config: Config, identity: string, metric: string, year: number, value: number, url: string, checksum: string, retrievedAt: Date) {
  const seriesKey = `${identity}:${metric.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
  const metadata = { SOURCE: config.source, AS_OF: `${year}-12-31`, RETRIEVED_AT: retrievedAt.toISOString(), UNIT: "metric tons copper/mineral content unless source workbook states otherwise", GEOGRAPHY: metric === "World production" ? "WORLD" : "US", FREQUENCY: "ANNUAL", CLASSIFICATION: "OFFICIAL", PIT_REVISION: "latest USGS published revision; vintage retained in sourceVersion" };
  const series = await prisma.economicSeries.upsert({
    where: { provider_seriesId: { provider: config.source, seriesId: seriesKey } },
    create: { provider: config.source, seriesId: seriesKey, code: identity, name: `${identity} ${metric}`, description: JSON.stringify(metadata), country: metric === "World production" ? "WORLD" : "US", category: "COMMODITY_FUNDAMENTALS", frequency: "ANNUAL", importance: "HIGH", unit: "metric tons", source: config.landingPage, apiUrl: url },
    update: { description: JSON.stringify(metadata), apiUrl: url, enabled: true, lastUpdate: retrievedAt }
  });
  await prisma.economicValue.upsert({
    where: { seriesId_date: { seriesId: series.id, date: new Date(Date.UTC(year, 11, 31)) } },
    create: { seriesId: series.id, date: new Date(Date.UTC(year, 11, 31)), value, sourceUrl: url, sourceVersion: config.dataset, rawChecksum: checksum, importedAt: retrievedAt },
    update: { value, sourceUrl: url, sourceVersion: config.dataset, rawChecksum: checksum, importedAt: retrievedAt }
  });
  return { seriesId: series.id, date: new Date(Date.UTC(year, 11, 31)) };
}
async function runBatch(prisma: PrismaClient, config: Config, cp: Checkpoint) {
  const target = isCanary ? config.canonicalTargets.find((x) => x.identity === config.canary.commodity)! : config.canonicalTargets[cp.targetIndex % config.canonicalTargets.length];
  const url = await resolveWorkbookUrl(config, target.label);
  const buffer = await fetchBuffer(url);
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const parsed = rowsFromWorkbook(buffer);
  const limit = isCanary ? config.canary.maxObservations : config.batch.maxObservations;
  const candidates: Array<{ metric: string; year: number; value: number }> = [];
  for (let r = parsed.rows.length - 1; r >= 0; r--) {
    for (const metric of config.metrics) {
      const column = parsed.headers.indexOf(metric);
      const value = Number(parsed.rows[r][column]);
      if (column >= 0 && Number.isFinite(value)) candidates.push({ metric, year: Number(parsed.rows[r][0]), value });
    }
  }
  const start = isCanary ? 0 : cp.rowIndex;
  const selected = candidates.slice(start, start + limit);
  const retrievedAt = new Date();
  const keys = [];
  for (const item of selected) keys.push(await persist(prisma, config, target.identity, item.metric, item.year, item.value, url, checksum, retrievedAt));
  const readback = keys.length ? await prisma.economicValue.count({ where: { OR: keys.map((key) => ({ seriesId: key.seriesId, date: key.date })) } }) : 0;
  if (readback !== keys.length) throw new Error(`USGS_READBACK_MISMATCH:${readback}/${keys.length}`);
  const exhausted = start + selected.length >= candidates.length;
  const next: Checkpoint = { targetIndex: exhausted ? (cp.targetIndex + 1) % config.canonicalTargets.length : cp.targetIndex, rowIndex: exhausted ? 0 : start + selected.length, metricIndex: 0, observationsPersisted: cp.observationsPersisted + selected.length, updatedAt: new Date().toISOString(), lastError: null, state: "AUTO_CONTINUING" };
  await atomicJson(CHECKPOINT, next);
  await atomicJson(HEARTBEAT, { source: config.source, pid: process.pid, state: next.state, commodity: target.identity, batchPersisted: selected.length, readback: "PASS", checkpoint: CHECKPOINT, updatedAt: next.updatedAt });
  console.log(JSON.stringify({ canary: isCanary, commodity: target.identity, observationsPersisted: selected.length, readback: "PASS", checkpoint: CHECKPOINT }));
  return next;
}
async function main() {
  const config: Config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  if (config.batch.maxDbConcurrency !== 1 || Number(process.env.MAX_DB_CONCURRENCY ?? "1") !== 1) throw new Error("MAX_DB_CONCURRENCY_MUST_EQUAL_1");
  const pool = process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER;
  if (pool) process.env.DATABASE_URL = pool;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_NOT_CONFIGURED");
  const prisma = new PrismaClient();
  let cp = await loadCheckpoint();
  try {
    do {
      try { cp = await runBatch(prisma, config, cp); if (isOnce) break; await waitForNextCycle(config, cp); }
      catch (error) {
        cp = { ...cp, state: "RETRY_WAIT", lastError: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() };
        await atomicJson(CHECKPOINT, cp); await atomicJson(HEARTBEAT, { source: config.source, pid: process.pid, state: cp.state, lastError: cp.lastError, updatedAt: cp.updatedAt });
        if (isOnce) throw error; await new Promise((resolve) => setTimeout(resolve, config.schedule.retryDelayMs));
      }
    } while (true);
  } finally { await prisma.$disconnect(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
