import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { boundedDbRetry, futuresDatabaseUrl } from "../../../lib/data-platform/runtime/boundedFuturesDb.ts";

const ROOT = process.cwd();
const RUNTIME = join(ROOT, "runtime", "interest-futures");
const DATA = join(RUNTIME, "data");
const RETRY = join(RUNTIME, "retry");
const ARCHIVE = join(RUNTIME, "archive");
const DEAD = join(RUNTIME, "dead-letter");
const EVENTS = join(RUNTIME, "events");
const CHECKPOINT = join(RUNTIME, "checkpoint.json");
const LOG = join(RUNTIME, "interest-futures.log");
const COMPLETION = join(RUNTIME, "completion-manifest.json");
const BACKGROUND = join(RUNTIME, "background-queue.json");
const LOCK = join(RUNTIME, "runner.lock");
const once = process.argv.includes("--once");
const prisma = new PrismaClient({ datasources: { db: { url: futuresDatabaseUrl() } } });

async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
const windowsBusy = (error) => error instanceof Error && ["EPERM", "EACCES", "EBUSY"].includes(String(error.code));
const wait = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function retryRename(from, to) { let last; for (let attempt = 0; attempt < 6; attempt++) { try { await rename(from, to); return; } catch (error) { last = error; if (!windowsBusy(error)) throw error; await wait(25 * (attempt + 1)); } } throw last; }
let atomicSequence = 0;
async function replaceAtomic(path, content) {
  const unique = `${process.pid}.${Date.now()}.${++atomicSequence}`, tmp = `${path}.${unique}.tmp`, backup = `${path}.${unique}.bak`;
  await writeFile(tmp, content, "utf8");
  try { await retryRename(tmp, path); } catch (error) {
    if (!windowsBusy(error)) throw error;
    let moved = false;
    try { await retryRename(path, backup); moved = true; await retryRename(tmp, path); await rm(backup, { force: true }); }
    catch (replacementError) { if (moved) await retryRename(backup, path).catch(() => undefined); throw replacementError; }
  } finally { await rm(tmp, { force: true }).catch(() => undefined); }
}
async function atomic(path, value) {
  await replaceAtomic(path, JSON.stringify(value, null, 2) + "\n");
}
async function atomicNdjson(path, rows) {
  await replaceAtomic(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}
async function log(message, detail = {}) {
  await appendFile(LOG, JSON.stringify({ timestamp: new Date().toISOString(), message, ...detail }) + "\n");
}
async function checkpoint(stage, extra = {}) {
  await atomic(CHECKPOINT, { asset: "GLOBAL_INTEREST_RATE_FUTURES", pid: process.pid, status: "RUNNING", currentStage: stage, updatedAt: new Date().toISOString(), autoContinuing: true, ...extra });
}
function contractMonth(text) {
  const m = String(text || "").match(/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(\d{2,4})/i);
  return m ? `${m[2].length === 2 ? "20" + m[2] : m[2]}-${String(["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].indexOf(m[1].toUpperCase()) + 1).padStart(2, "0")}` : null;
}
function number(value) {
  const n = Number(String(value ?? "").replaceAll(",", "").replace(/[AB]$/i, ""));
  return Number.isFinite(n) ? n : null;
}
function observationKey(row) {
  return [row.contractId || `${row.exchange}:${row.contractCode}`, row.observationTimestamp || row.observedAt || row.timestamp, row.observationType || "SETTLEMENT", row.source].join("|");
}
function jpxFreshness(observedAt) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const parts = Object.fromEntries(today.map((part) => [part.type, part.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const observationDate = new Date(observedAt).toISOString().slice(0, 10);
  if (parts.weekday === "Sat" || parts.weekday === "Sun" || Number(parts.hour) < 17) return "WAITING_FOR_SETTLEMENT";
  if (observationDate === localDate) return "CURRENT";
  return "SOURCE_DELAYED";
}
function csvRow(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}
async function fetchJpxOse(instrument) {
  const indexUrl = "https://www.jpx.co.jp/english/markets/derivatives/settlement-price/index.html";
  const indexResponse = await fetch(indexUrl, { signal: AbortSignal.timeout(30000) });
  if (!indexResponse.ok) throw new Error(`JPX index HTTP ${indexResponse.status}`);
  const html = await indexResponse.text();
  const match = html.match(/href="([^"]+\/rb_e(\d{8})\.csv)"/i);
  if (!match) throw new Error("JPX settlement CSV link not found");
  const sourceUrl = new URL(match[1], indexUrl).toString();
  const observedAt = new Date(`${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6, 8)}T00:00:00Z`);
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`JPX CSV HTTP ${response.status}`);
  const csv = new TextDecoder("utf-8").decode(await response.arrayBuffer());
  const retrievedAt = new Date().toISOString();
  const rawRows = csv.split(/\r?\n/).filter((line) => line.includes("FUT_TOA3M_"));
  const result = rawRows.map((raw) => {
    const row = csvRow(raw);
    const expirationCode = row[1]?.match(/_(\d{6})$/)?.[1];
    if (!expirationCode || number(row[5]) === null) throw new Error(`JPX invalid 3-Month TONA row: ${row[1] || "missing contract"}`);
    const expiration = new Date(`20${expirationCode.slice(0, 2)}-${expirationCode.slice(2, 4)}-${expirationCode.slice(4, 6)}T00:00:00Z`);
    const month = String(row[3]);
    const contractMonthDate = new Date(`${month.slice(0, 4)}-${month.slice(4, 6)}-01T00:00:00Z`);
    const checksum = `PLATFORM_DERIVED_SHA256:${createHash("sha256").update(raw).digest("hex")}`;
    return {
      instrumentId: instrument.id, contractId: `OSE:${row[1]}`, contractCode: row[1], contractMonth: `${month.slice(0, 4)}-${month.slice(4, 6)}`,
      observationTimestamp: observedAt.toISOString(), observationType: "SETTLEMENT", settlementPrice: number(row[5]), settlementDate: observedAt.toISOString().slice(0, 10),
      settlement: number(row[5]), expirationDate: expiration.toISOString(), expiration: expiration.toISOString(), observedAt,
      contractMonthDate, currency: instrument.currency, underlying: row[11], exchange: "OSE", daysToExpiry: number(row[10]),
      volume: null, openInterest: null, sourceRecordId: `JPX_NATIVE_ISSUE_CODE:${match[2]}:${row[0]}`, source: "JPX_OSE_OFFICIAL_SETTLEMENT_CSV", sourceType: "OFFICIAL_PUBLIC_DOWNLOAD", sourceUrl,
      asOfDate: observedAt.toISOString(), ingestedAt: retrievedAt, verificationStatus: "VERIFIED_OFFICIAL", licenseStatus: "PUBLIC", freshnessStatus: jpxFreshness(observedAt), sourceChecksum: checksum,
      parserVersion: "jpx-ose-tona-settlement-csv/3.0.0", quality: "OFFICIAL_DAILY_SETTLEMENT", ohlcStatus: "SOURCE_NOT_AVAILABLE", volumeStatus: "SOURCE_NOT_AVAILABLE", openInterestStatus: "SOURCE_NOT_AVAILABLE"
    };
  });
  if (result.length < 4) throw new Error(`JPX listed strip incomplete: ${result.length}`);
  return result;
}
async function writeCanonical(instrument, rows) {
  await boundedDbRetry(() => prisma.$transaction(async (tx) => {
    for (const row of rows) {
    const contractId = randomUUID();
    const contracts = await tx.$queryRaw`
      INSERT INTO futures_contracts (id, underlying, exchange, root_symbol, contract_symbol, contract_month, expiration, currency, source, created_at, updated_at, asset_class, contract_year, last_trade_date, status, verification_status, source_url, identity_state, expiration_source_url)
      VALUES (${contractId}::uuid, ${row.underlying}, ${row.exchange}, ${instrument.root}, ${row.contractCode}, ${row.contractMonthDate}, ${new Date(row.expiration)}, ${row.currency}, ${row.source}, NOW(), NOW(), 'INTEREST_RATE_FUTURES', ${row.contractMonthDate.getUTCFullYear()}, ${new Date(row.expiration)}, 'ACTIVE', 'VERIFIED', ${instrument.sourceDocument || row.sourceUrl}, 'VERIFIED_OFFICIAL_LISTED', ${row.sourceUrl})
      ON CONFLICT (exchange, contract_symbol) DO UPDATE SET contract_month = EXCLUDED.contract_month, expiration = EXCLUDED.expiration, last_trade_date = EXCLUDED.last_trade_date, status = 'ACTIVE', source = EXCLUDED.source, verification_status = 'VERIFIED', source_url = EXCLUDED.source_url, identity_state = EXCLUDED.identity_state, expiration_source_url = EXCLUDED.expiration_source_url, updated_at = NOW()
      RETURNING id
    `;
    const canonicalContractId = contracts[0]?.id;
    if (!canonicalContractId) throw new Error(`Canonical contract mapping failed: ${row.contractCode}`);
    const sourceKey = `${row.source}:${row.contractCode}:${row.observedAt.toISOString()}`;
    const observationId = randomUUID();
    await tx.$executeRaw`
      INSERT INTO futures_observations (id, contract_id, observed_at, settlement, source, source_key, created_at, updated_at, asset_class, source_record_id, source_url, verification_status, quality_status, freshness_status, retrieved_at, parser_version, source_checksum, license_status, contract_identity_state, raw_checksum)
      VALUES (${observationId}::uuid, ${canonicalContractId}::uuid, ${row.observedAt}, ${row.settlement}, ${row.source}, ${sourceKey}, NOW(), NOW(), 'INTEREST_RATE_FUTURES', ${row.sourceRecordId}, ${row.sourceUrl}, 'VERIFIED', 'OFFICIAL_DAILY_SETTLEMENT', ${row.freshnessStatus}, ${new Date(row.ingestedAt)}, ${row.parserVersion}, ${row.sourceChecksum}, 'PUBLIC', 'VERIFIED_OFFICIAL_LISTED', ${row.sourceChecksum})
      ON CONFLICT (source_key) DO UPDATE SET settlement = EXCLUDED.settlement, source = EXCLUDED.source, source_record_id = EXCLUDED.source_record_id, source_url = EXCLUDED.source_url, verification_status = 'VERIFIED', quality_status = EXCLUDED.quality_status, freshness_status = EXCLUDED.freshness_status, retrieved_at = EXCLUDED.retrieved_at, parser_version = EXCLUDED.parser_version, source_checksum = EXCLUDED.source_checksum, license_status = 'PUBLIC', contract_identity_state = EXCLUDED.contract_identity_state, raw_checksum = EXCLUDED.raw_checksum, updated_at = NOW()
    `;
    const readBack = await tx.$queryRaw`SELECT source_key FROM futures_observations WHERE source_key = ${sourceKey} LIMIT 1`;
    if (!readBack[0]) throw new Error(`Canonical read-back failed: ${sourceKey}`);
    }
  }, { maxWait: 30000, timeout: 120000 }));
}
async function fetchCme(instrument) {
  const url = `https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements/${encodeURIComponent(instrument.root)}?pageSize=500`;
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "SmartFund-Interest-Futures/1.0" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`CME HTTP ${response.status}`);
  const body = await response.json();
  const rows = body.settlements || body;
  if (!Array.isArray(rows)) throw new Error("CME response has no settlements array");
  const timestamp = new Date().toISOString();
  return rows.map((r) => ({
    instrumentId: instrument.id, contractCode: r.productId || r.contract || r.month, contractMonth: contractMonth(r.month || r.contract),
    open: number(r.open), high: number(r.high), low: number(r.low), close: number(r.last), volume: number(r.volume),
    openInterest: number(r.openInterest), settlement: number(r.settle), expiration: r.expiration || null,
    continuousContract: false, rollRule: null, timestamp, timezone: instrument.timezone,
    source: "CME_GROUP_OFFICIAL_PUBLIC", sourceUrl: url, quality: "OFFICIAL_DELAYED_SETTLEMENT"
  })).filter((r) => r.contractMonth);
}
async function saveRows(instrument, rows, stage) {
  const file = join(DATA, `${instrument.id}.ndjson`);
  let existing = [];
  try { existing = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch {}
  const before = existing.length;
  const merged = new Map();
  for (const row of existing) merged.set(observationKey(row), row);
  for (const row of rows) {
    const key = observationKey(row);
    const previous = merged.get(key);
    merged.set(key, { ...previous, ...row, ingestionStages: [...new Set([...(previous?.ingestionStages || (previous?.ingestionStage ? [previous.ingestionStage] : [])), stage])] });
  }
  if (before > merged.size) {
    const backup = join(ARCHIVE, `${instrument.id}-pre-dedup-${Date.now()}.ndjson`);
    await writeFile(backup, existing.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    await log("runtime_duplicates_archived", { instrumentId: instrument.id, before, after: merged.size, backup });
  }
  await atomicNdjson(file, [...merged.values()]);
  return rows.length;
}
async function enqueue(instrument, stage, error, attempt = 1) {
  const message = String(error?.message || error);
  const retryable = /fetch failed|timeout|ECONNRESET|EAI_AGAIN|HTTP 5\d\d|25006|read-only transaction|P1001|P1017|max clients/i.test(message);
  const category = retryable ? "TRANSIENT_DB_OR_NETWORK" : /access blocked/i.test(message) ? "SOURCE_ACCESS_BLOCKED" : /license/i.test(message) ? "LICENSE_BLOCKED" : /pending|not implemented/i.test(message) ? "NOT_IMPLEMENTED" : "OTHER_VERIFIED";
  const item = { instrumentId: instrument.id, venue: instrument.venue, stage, category, retryable, attempt, nextAttemptAt: retryable ? new Date(Date.now() + Math.min(3600000, 60000 * 2 ** attempt)).toISOString() : null, error: message, createdAt: new Date().toISOString() };
  await atomic(join(retryable ? RETRY : DEAD, `${instrument.id}-${stage}.json`), item);
  await log(retryable ? "queued_retry" : "isolated_dead_letter", item);
}
async function collect(instrument, stage) {
  try {
    if (instrument.venue !== "OSE") throw new Error(`${instrument.venue} official source access blocked or adapter not implemented`);
    const rows = await fetchJpxOse(instrument);
    await writeCanonical(instrument, rows);
    for (const row of rows) await atomic(join(EVENTS, `${row.contractId.replaceAll(":", "_")}-expiry.json`), { eventType: "EXPIRY", contractId: row.contractId, eventDate: row.expirationDate, source: row.source, verificationStatus: "VERIFIED_OFFICIAL" });
    return await saveRows(instrument, rows, stage);
  } catch (error) { await enqueue(instrument, stage, error); return 0; }
}
async function archive() {
  for (const name of ["interest-futures.log"]) {
    const path = join(RUNTIME, name);
    try { if ((await stat(path)).size > 10_000_000) await rename(path, join(ARCHIVE, `${Date.now()}-${name}`)); } catch {}
  }
}
async function cycle(universe) {
  const stages = ["LATEST", "INCREMENTAL"];
  let records = 0;
  for (const stage of stages) {
    await checkpoint(stage, { records });
    for (const instrument of universe.instruments) records += await collect(instrument, stage);
  }
  await checkpoint("RETRY", { records });
  await checkpoint("ARCHIVE", { records });
  await archive();
  await atomic(COMPLETION, { asset: "GLOBAL_INTEREST_RATE_FUTURES", cycleCompletedAt: new Date().toISOString(), records, stages, continuousContractRule: universe.continuousContract, nextMode: once ? "EXIT" : "SCHEDULED_INCREMENTAL" });
  await log("cycle_complete", { records });
  return records;
}
async function acquireLock() {
  try {
    const handle = await open(LOCK, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    let owner;
    try { owner = JSON.parse(await readFile(LOCK, "utf8")); process.kill(owner.pid, 0); } catch { await unlink(LOCK).catch(() => {}); return acquireLock(); }
    throw new Error(`DOUBLE_WRITER_BLOCKED existingPid=${owner.pid}`);
  }
}
async function seedBackgroundQueue() {
  const tasks = [
    { id: "OSE_TONA_3M:LISTED_STRIP", entity: "OSE_TONA_3M", kind: "LISTED_STRIP", status: "ACTIVE", bounded: true },
    { id: "OSE_TONA_3M:CURVE_SNAPSHOT", entity: "OSE_TONA_3M", kind: "CURVE_SNAPSHOT", status: "ACTIVE", bounded: true },
    { id: "OSE_TONA_3M:CURRENT_SETTLEMENT", entity: "OSE_TONA_3M", kind: "CURRENT_SETTLEMENT", status: "ACTIVE", bounded: true },
    { id: "OSE_TONA_3M:PROVENANCE", entity: "OSE_TONA_3M", kind: "PROVENANCE", status: "ACTIVE", bounded: true },
    { id: "OSE_TONA_3M:HISTORY_BACKFILL", entity: "OSE_TONA_3M", kind: "HISTORY_BACKFILL", status: "BLOCKED_SOURCE_LIMITATION", bounded: true },
    { id: "OSE_TONA_3M:CONTINUOUS_SERIES", entity: "OSE_TONA_3M", kind: "CONTINUOUS_SERIES", status: "BLOCKED_INSUFFICIENT_CONTRACT_CHAIN", bounded: true },
    { id: "OSE_TONA_3M:ROLL_EVENTS", entity: "OSE_TONA_3M", kind: "ROLL_EVENTS", status: "BLOCKED_NO_CONTINUOUS_SERIES", bounded: true }
  ];
  await atomic(BACKGROUND, { version: 1, singleWriter: true, maxQueueSize: 32, tasks, updatedAt: new Date().toISOString() });
}
async function reconcileLegacyRetryQueue() {
  for (const name of await readdir(RETRY)) {
    if (!name.endsWith(".json")) continue;
    const path = join(RETRY, name);
    let item;
    try { item = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
    const retryable = item.venue === "OSE" && /fetch failed|timeout|ECONNRESET|EAI_AGAIN|HTTP 5\d\d/i.test(String(item.error));
    if (retryable) {
      await atomic(path, { ...item, category: "TRANSIENT_NETWORK", retryable: true });
      continue;
    }
    const category = /upsert|write|Prisma/i.test(String(item.error)) ? "WRITE_FAILURE" : /license/i.test(String(item.error)) ? "LICENSE_BLOCKED" : /pending|adapter/i.test(String(item.error)) ? "NOT_IMPLEMENTED" : "SOURCE_ACCESS_BLOCKED";
    await atomic(join(DEAD, name), { ...item, category, retryable: false, nextAttemptAt: null, isolatedAt: new Date().toISOString() });
    await rename(path, join(ARCHIVE, `legacy-retry-${Date.now()}-${name}`));
  }
}
async function reconcileRuntimeDuplicates() {
  for (const name of await readdir(DATA)) {
    if (!name.endsWith(".ndjson")) continue;
    const path = join(DATA, name);
    const originalRows = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const rows = originalRows.map((row) => row.instrumentId === "OSE_TONA_3M" ? {
      ...row,
      contractId: row.contractId || `OSE:${row.contractCode}`,
      contractMonth: String(row.contractMonth).replace(/^(\d{4})(\d{2})$/, "$1-$2"),
      observationTimestamp: row.observationTimestamp || new Date(row.observedAt).toISOString(),
      observationType: "SETTLEMENT",
      settlementPrice: row.settlementPrice ?? row.settlement,
      settlementDate: row.settlementDate || new Date(row.observedAt).toISOString().slice(0, 10),
      expirationDate: row.expirationDate || row.expiration,
      volume: row.volume ?? null,
      openInterest: row.openInterest ?? null,
      sourceRecordId: row.sourceRecordId || row.contractCode,
      sourceType: "OFFICIAL_PUBLIC_DOWNLOAD",
      asOfDate: row.asOfDate || new Date(row.observedAt).toISOString(),
      ingestedAt: row.ingestedAt || new Date().toISOString(),
      verificationStatus: "VERIFIED_OFFICIAL",
      licenseStatus: "PUBLIC",
      freshnessStatus: jpxFreshness(row.observedAt),
      ohlcStatus: "SOURCE_NOT_AVAILABLE",
      volumeStatus: "SOURCE_NOT_AVAILABLE",
      openInterestStatus: "SOURCE_NOT_AVAILABLE"
    } : row);
    const unique = new Map();
    for (const row of rows) unique.set(observationKey(row), row);
    const normalizationRequired = JSON.stringify(originalRows) !== JSON.stringify(rows);
    if (unique.size === rows.length && !normalizationRequired) continue;
    await writeFile(join(ARCHIVE, `${name.replace(/\.ndjson$/, "")}-pre-quality-repair-${Date.now()}.ndjson`), originalRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    await atomicNdjson(path, [...unique.values()]);
    await log("startup_runtime_quality_repair_complete", { file: name, before: rows.length, after: unique.size, normalized: normalizationRequired, uniqueness: "contractId+observationTimestamp+observationType+source" });
  }
}
async function main() {
  await Promise.all([RUNTIME, DATA, RETRY, ARCHIVE, DEAD, EVENTS].map((p) => mkdir(p, { recursive: true })));
  await acquireLock();
  await reconcileLegacyRetryQueue();
  await reconcileRuntimeDuplicates();
  await writeFile(join(RUNTIME, "pid"), String(process.pid) + "\n");
  const universe = await json(join(ROOT, "config", "interest-futures-universe.json"));
  await seedBackgroundQueue();
  await checkpoint("BOOTSTRAP");
  await log("runner_started", { pid: process.pid, once });
  do {
    await cycle(universe);
    if (!once) {
      await checkpoint("SCHEDULED_INCREMENTAL", { nextRunAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 15 * 60_000));
    }
  } while (!once);
  await atomic(CHECKPOINT, { asset: "GLOBAL_INTEREST_RATE_FUTURES", pid: process.pid, status: "COMPLETED", currentStage: "COMPLETED", updatedAt: new Date().toISOString(), autoContinuing: false });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await unlink(LOCK).catch(() => {}); await prisma.$disconnect(); process.exit(0); });
main().catch(async (error) => { try { await log("fatal", { error: String(error?.stack || error) }); await checkpoint("FATAL", { error: String(error?.message || error) }); } finally { await unlink(LOCK).catch(() => {}); await prisma.$disconnect(); process.exitCode = 1; } });
