import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import AdmZip from "adm-zip";
import { PDFParse } from "pdf-parse";
import { PrismaClient } from "@prisma/client";
import { boundedDbRetry, futuresDatabaseUrl, MAX_DB_CONCURRENCY } from "../../../lib/data-platform/runtime/boundedFuturesDb.ts";

const cwd = process.cwd();
const once = process.argv.includes("--once");
const db = new PrismaClient({ datasources: { db: { url: futuresDatabaseUrl() } } });
const checkpointFile = resolve(cwd, "runtime/futures-market-data-expansion/jpx-daily-history-checkpoint.json");
const base = "https://www.jpx.co.jp";
const parserVersion = "jpx-official-daily-pdf-v1";
const intervalMs = 60 * 1000;
const requestedBatch = Number(process.argv.find(value => value.startsWith("--batch-size="))?.split("=")[1] ?? (once ? 30 : 10));
const batchSize = Number.isFinite(requestedBatch) ? Math.max(1, Math.min(30, Math.trunc(requestedBatch))) : 10;
type Point = { issueCode: string; open: string; high: string; low: string; close: string; settlement: string; volume: string; openInterest: string };
type Checkpoint = { completed_dates?: string[]; [key: string]: unknown };
const now = () => new Date().toISOString();
function uuid(seed: string) { const h = createHash("sha256").update(seed).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; }
async function atomic(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, path); }
async function json<T>(path: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
const clean = (value: string) => value.replaceAll(",", "");

function parsePoints(text: string) {
  const n = String.raw`[\d,.]+`;
  const pattern = new RegExp(String.raw`(\d{6,8})\s+\d{2}\.\d{2}\s+([A-Z0-9]{9})\s+(${n})\s+(${n})\s+(${n})\s+(${n})\s+(?:${n}\s+){4}[+-]?\s*${n}\s+(${n})\s+${n}\s+(${n})\s+(${n})`, "g");
  const points: Point[] = [];
  for (const m of text.matchAll(pattern)) points.push({ issueCode: m[2], open: clean(m[3]), high: clean(m[4]), low: clean(m[5]), close: clean(m[6]), volume: clean(m[7]), settlement: clean(m[8]), openInterest: clean(m[9]) });
  return points;
}

async function reportIndex(month: string) {
  const modern = month >= "202601";
  const url = modern ? `${base}/automation/markets/statistics-derivatives/daily/json/daily_report_${month}.json` : `${base}/automation/markets/statistics-derivatives/daily/json/e_daily_report_${month}.html`;
  const response = await fetch(url, { headers: { "User-Agent": "SmartFund official-public-data-ingestion/1.0" } });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`JPX_INDEX_HTTP_${response.status}:${month}`);
  if (modern) {
    const body = await response.json() as any;
    return (body.TableDatas ?? []).map((row: any) => ({ date: String(row.TradeDate), urls: [row.OseAll, row.TocomAll].filter(Boolean) as string[] }));
  }
  const html = await response.text(), days = new Map<string, string[]>();
  for (const match of html.matchAll(/href="([^"]*\/(\d{8})_(?:Quotations_(?:Index_Futures_and_Options_and_Equity_Options|JGB_Futures_and_Options|OSE_Commodity_Futures_and_Options|TOCOM_Commodity_Futures)[^"]*)\.pdf)"/gi)) {
    const urls = days.get(match[2]) ?? []; urls.push(match[1]); days.set(match[2], urls);
  }
  return [...days].map(([date, urls]) => ({ date, urls }));
}

async function fetchDay(item: { date: string; urls: string[] }) {
  const points: Point[] = [], checksums: string[] = [];
  for (const relative of item.urls) {
    const sourceUrl = new URL(relative, base).href;
    const response = await fetch(sourceUrl, { headers: { "User-Agent": "SmartFund official-public-data-ingestion/1.0" } });
    if (!response.ok) throw new Error(`JPX_ZIP_HTTP_${response.status}:${item.date}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    checksums.push(createHash("sha256").update(bytes).digest("hex"));
    const documents = /\.pdf$/i.test(relative) ? [bytes] : new AdmZip(bytes).getEntries().filter(entry => /(?:sif_dyr|cdf_dyr|jgbf_irf_dyr).*\.pdf$/i.test(entry.entryName)).map(entry => entry.getData());
    for (const document of documents) {
      const parser = new PDFParse({ data: document });
      try { points.push(...parsePoints((await parser.getText()).text)); } finally { await parser.destroy(); }
    }
  }
  const unique = [...new Map(points.map(point => [point.issueCode, point])).values()];
  return { points: unique, checksum: createHash("sha256").update(checksums.join(":"), "utf8").digest("hex") };
}

async function mappings() {
  const rows = await boundedDbRetry(() => db.$queryRawUnsafe<any[]>(`SELECT DISTINCT ON (source_record_id) source_record_id,contract_id::text,asset_class FROM futures_observations WHERE source_record_id IS NOT NULL AND source LIKE 'JPX_%' ORDER BY source_record_id,observed_at DESC`));
  return new Map(rows.map(row => [row.source_record_id, row]));
}

async function counts() {
  const [row] = await boundedDbRetry(() => db.$queryRawUnsafe<any[]>(`SELECT count(*)::int rows,count(DISTINCT contract_id)::int products,count(*) FILTER(WHERE open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL)::int ohlc_rows,count(*) FILTER(WHERE volume IS NOT NULL)::int volume_rows,count(*) FILTER(WHERE open_interest IS NOT NULL)::int oi_rows,count(*) FILTER(WHERE settlement IS NOT NULL)::int settlement_rows,min(observed_at)::text earliest,max(observed_at)::text latest FROM futures_observations WHERE source='JPX_OFFICIAL_DAILY_REPORT_PDF'`));
  return row;
}

async function ingestDay(item: { date: string; urls: string[] }, map: Map<string, any>) {
  const fetched = await fetchDay(item), observed = `${item.date.slice(0, 4)}-${item.date.slice(4, 6)}-${item.date.slice(6, 8)}`;
  const eligible = fetched.points.filter(point => {
    if (!map.has(point.issueCode) || !/^\d+$/.test(point.volume) || !/^\d+$/.test(point.openInterest)) return false;
    const open = Number(point.open), high = Number(point.high), low = Number(point.low), close = Number(point.close), settlement = Number(point.settlement);
    return [open, high, low, close, settlement].every(Number.isFinite) && high >= Math.max(open, close) && low <= Math.min(open, close) && Number(point.volume) >= 0 && Number(point.openInterest) >= 0;
  });
  if (!eligible.length) throw new Error(`JPX_NO_IDENTITY_MATCH:${item.date}:${fetched.points.length}`);
  await boundedDbRetry(() => db.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('smartfund:FUTURES_JPX_DAILY_HISTORY'))::text AS locked`);
    for (const point of eligible) {
      const identity = map.get(point.issueCode), sourceKey = `JPX_DAILY:${point.issueCode}:${observed}`;
      await tx.$executeRawUnsafe(`INSERT INTO futures_observations(id,contract_id,observed_at,open,high,low,close,settlement,volume,open_interest,asset_class,source_record_id,source_url,verification_status,quality_status,freshness_status,source,source_key,retrieved_at,parser_version,source_checksum,license_status,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3::date,$4::numeric,$5::numeric,$6::numeric,$7::numeric,$8::numeric,$9::bigint,$10::bigint,$11,$12,$13,'VERIFIED_OFFICIAL','OFFICIAL_CONTRACT_GRAIN','MARKET_CLOSED','JPX_OFFICIAL_DAILY_REPORT_PDF',$14,NOW(),$15,$16,'PUBLIC_OFFICIAL',NOW(),NOW()) ON CONFLICT(contract_id,observed_at) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,settlement=EXCLUDED.settlement,volume=EXCLUDED.volume,open_interest=EXCLUDED.open_interest,source_record_id=EXCLUDED.source_record_id,source_url=EXCLUDED.source_url,verification_status='VERIFIED_OFFICIAL',quality_status='OFFICIAL_CONTRACT_GRAIN',freshness_status='MARKET_CLOSED',source='JPX_OFFICIAL_DAILY_REPORT_PDF',retrieved_at=NOW(),parser_version=EXCLUDED.parser_version,source_checksum=EXCLUDED.source_checksum,license_status='PUBLIC_OFFICIAL',updated_at=NOW()`, uuid(`obs:${sourceKey}`), identity.contract_id, observed, point.open, point.high, point.low, point.close, point.settlement, point.volume, point.openInterest, identity.asset_class, point.issueCode, new URL(item.urls[0], base).href, sourceKey, parserVersion, fetched.checksum);
    }
  }, { maxWait: 30000, timeout: 120000 }));
  const [readback] = await boundedDbRetry(() => db.$queryRawUnsafe<any[]>(`SELECT count(*)::int rows FROM futures_observations WHERE source='JPX_OFFICIAL_DAILY_REPORT_PDF' AND observed_at=$1::date AND open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL AND volume IS NOT NULL AND open_interest IS NOT NULL AND settlement IS NOT NULL`, observed));
  if (readback.rows < eligible.length) throw new Error(`JPX_DAILY_READBACK_FAILED:${item.date}:${readback.rows}/${eligible.length}`);
  return { parsed: fetched.points.length, matched: eligible.length, readback: readback.rows };
}

async function cycle() {
  const checkpoint = await json<Checkpoint>(checkpointFile, {}), completed = new Set(checkpoint.completed_dates ?? []), map = await mappings(), before = await counts();
  const months = Array.from({ length: 13 }, (_, index) => { const date = new Date(Date.UTC(2026, 7 - index, 1)); return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`; });
  const indexes = (await Promise.all(months.map(reportIndex))).flat().sort((a, b) => a.date.localeCompare(b.date));
  const pending = indexes.filter(item => !completed.has(item.date));
  const batch = pending.slice(0, batchSize);
  const progress: any[] = [];
  for (const item of batch) { const result = await ingestDay(item, map); completed.add(item.date); progress.push({ date: item.date, ...result }); await atomic(checkpointFile, { asset: "FUTURES", worker: "FUTURES_JPX_OFFICIAL_DAILY_HISTORY", pid: process.pid, state: "RUNNING", max_db_concurrency: MAX_DB_CONCURRENCY, completed_dates: [...completed].sort(), last_progress: progress.at(-1), updated_at: now() }); }
  const after = await counts(), nextRunAt = once ? null : new Date(Date.now() + intervalMs).toISOString();
  await atomic(checkpointFile, { asset: "FUTURES", worker: "FUTURES_JPX_OFFICIAL_DAILY_HISTORY", pid: process.pid, state: once ? "COMPLETE" : pending.length > batch.length ? "SCHEDULED_WAIT" : "COMPLETE_AS_AVAILABLE", max_db_concurrency: MAX_DB_CONCURRENCY, before, after, progress, completed_dates: [...completed].sort(), checkpoint: `JPX_DAILY:HISTORY_DATES:${completed.size}:ROWS:${after.rows}:READBACK_PASS`, next_run_at: nextRunAt, auto_continuing: !once && pending.length > batch.length, updated_at: now() });
  console.log(JSON.stringify({ before, after, progress, pending: Math.max(0, pending.length - batch.length), nextRunAt }));
}

async function main() { do { await cycle(); if (once) break; await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs)); } while (true); }
main().catch(async error => { const old = await json<Checkpoint>(checkpointFile, {}); await atomic(checkpointFile, { ...old, asset: "FUTURES", worker: "FUTURES_JPX_OFFICIAL_DAILY_HISTORY", pid: process.pid, state: "BLOCKED", last_error: String(error), next_run_at: null, auto_continuing: false, updated_at: now() }); console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
