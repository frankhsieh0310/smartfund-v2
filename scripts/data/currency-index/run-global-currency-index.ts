import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { prisma } from "../../../lib/prisma.ts";
import { loadCurrencyIndexConfig, type CurrencyIndex } from "./currency-index-config.ts";

type Stage = "HISTORICAL" | "LATEST" | "INCREMENTAL";
type Work = { key: string; asset: string; interval: string; stage: Stage; attempts: number; nextRunAt: string };
type Checkpoint = { version: 1; stage: Stage; current: string | null; completed: Record<string, string>; retry: Work[]; deadLetter: Array<Work & { error: string }>; cycles: number; updatedAt: string; dxyLatestAt?: string };
type Row = { asset: string; timestamp: string; timezone: "UTC"; session: string; interval: string; open: number; high: number; low: number; close: number; volume: number | null; source: string; completeness: "COMPLETE" | "PARTIAL"; quality: "OFFICIAL" | "DERIVED"; components?: number };

const root = resolve("runtime", "currency-index");
const paths = { checkpoint: resolve(root, "checkpoint.json"), lock: resolve(root, "standalone.lock"), log: resolve(root, "standalone.log"), manifest: resolve(root, "completion-manifest.json"), coverage: resolve(root, "coverage-matrix.json"), latest: resolve(root, "latest.json"), technical: resolve(root, "technical.json"), comparison: resolve(root, "comparison.json") };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function atomic(path: string, value: string | Uint8Array) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
async function log(event: Record<string, unknown>) { const handle = await open(paths.log, "a"); try { await handle.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); } finally { await handle.close(); } }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function lock() { await mkdir(root, { recursive: true }); try { const old = JSON.parse(await readFile(paths.lock, "utf8")) as { pid: number }; if (old.pid && alive(old.pid)) throw new Error(`CURRENCY_INDEX_ALREADY_RUNNING:${old.pid}`); await unlink(paths.lock).catch(() => undefined); } catch (error) { if (error instanceof Error && error.message.startsWith("CURRENCY_INDEX_ALREADY_RUNNING")) throw error; } const handle = await open(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); await handle.write(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })); await handle.close(); }
async function checkpoint(): Promise<Checkpoint> { try { return JSON.parse(await readFile(paths.checkpoint, "utf8")) as Checkpoint; } catch { return { version: 1, stage: "HISTORICAL", current: null, completed: {}, retry: [], deadLetter: [], cycles: 0, updatedAt: new Date().toISOString() }; } }
async function save(state: Checkpoint) { state.updatedAt = new Date().toISOString(); await atomic(paths.checkpoint, `${JSON.stringify(state, null, 2)}\n`); }

function addDeadLetter(state: Checkpoint, work: Work, error: string) {
  const duplicate = state.deadLetter.some((item) => item.asset === work.asset && item.interval === work.interval && item.stage === work.stage && item.error === error);
  if (!duplicate) state.deadLetter.push({ ...work, error });
}

async function syncDxyLatest() {
  const symbol = "DXY";
  const sourceSymbol = "DX-Y.NYB";
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sourceSymbol)}`);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("range", "10d");
  url.searchParams.set("events", "history");
  const response = await fetch(url, { headers: { "user-agent": "SmartFund-Currency-Index/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`DXY_YAHOO_HTTP_${response.status}`);
  const body = await response.json() as any;
  const result = body.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const observations = (result?.timestamp ?? []).flatMap((epoch: number, index: number) => {
    const close = Number(quote?.close?.[index]);
    if (!Number.isFinite(close)) return [];
    return [{
      date: new Date(`${new Date(epoch * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`),
      open: Number.isFinite(Number(quote?.open?.[index])) ? Number(quote.open[index]) : null,
      high: Number.isFinite(Number(quote?.high?.[index])) ? Number(quote.high[index]) : null,
      low: Number.isFinite(Number(quote?.low?.[index])) ? Number(quote.low[index]) : null,
      close,
      volume: Number.isFinite(Number(quote?.volume?.[index])) ? Number(quote.volume[index]) : null,
    }];
  }).sort((a: { date: Date }, b: { date: Date }) => a.date.getTime() - b.date.getTime());
  const latest = observations.at(-1);
  if (!latest) throw new Error("DXY_YAHOO_NO_VALID_OBSERVATION");
  const previous = observations.at(-2);
  const changePts = previous ? latest.close - previous.close : null;
  const changePct = previous && previous.close !== 0 ? (changePts! / previous.close) * 100 : null;
  const source = `Yahoo Chart:${sourceSymbol}`;

  await prisma.marketMaster.upsert({
    where: { symbol },
    create: { symbol, name: "US Dollar Index", nameZh: "美元指數", assetType: "INDEX", region: "GLOBAL", country: "US", exchange: "ICE", currency: "USD", category: "CURRENCY_INDEX", provider: source, latestClose: latest.close, latestDate: latest.date, latestChange: changePts, latestChangePct: changePct },
    update: { name: "US Dollar Index", nameZh: "美元指數", assetType: "INDEX", region: "GLOBAL", country: "US", exchange: "ICE", currency: "USD", category: "CURRENCY_INDEX", provider: source, isActive: true, latestClose: latest.close, latestDate: latest.date, latestChange: changePts, latestChangePct: changePct },
  });
  await prisma.marketData.upsert({
    where: { symbol_date: { symbol, date: latest.date } },
    create: { symbol, name: "US Dollar Index", nameZh: "美元指數", type: "INDEX", date: latest.date, close: latest.close, open: latest.open, high: latest.high, low: latest.low, volume: latest.volume, changePts, changePct, region: "GLOBAL", currency: "USD", source },
    update: { close: latest.close, open: latest.open, high: latest.high, low: latest.low, volume: latest.volume, changePts, changePct, source },
  });
  const readBack = await prisma.marketData.findUnique({ where: { symbol_date: { symbol, date: latest.date } } });
  if (!readBack || Number(readBack.close).toFixed(4) !== latest.close.toFixed(4) || readBack.source !== source) throw new Error("DXY_CANONICAL_READ_BACK_FAILED");
  return { symbol, sourceSymbol, date: latest.date.toISOString().slice(0, 10), close: latest.close, source };
}

function yahooInterval(interval: string) { return ({ "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "60m": "60m", "4h": "60m", "1D": "1d", "1W": "1wk", "1M": "1mo" } as Record<string, string>)[interval]; }
function range(interval: string, stage: Stage) { if (stage !== "HISTORICAL") return ["1D", "1W", "1M"].includes(interval) ? "10d" : "2d"; return interval === "1m" ? "7d" : ["5m", "15m", "30m", "60m", "4h"].includes(interval) ? "60d" : "max"; }
function bucketMs(interval: string) { return ({ "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "60m": 3600e3, "4h": 14400e3, "1D": 86400e3, "1W": 604800e3, "1M": 2592000e3 } as Record<string, number>)[interval]; }

async function fredRows(asset: CurrencyIndex, interval: string): Promise<Row[]> {
  if (!asset.series) throw new Error("MISSING_FRED_SERIES");
  if (!["1D", "1W", "1M"].includes(interval)) return [];
  const response = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${asset.series}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`FRED_HTTP_${response.status}`);
  const daily = (await response.text()).trim().split(/\r?\n/).slice(1).flatMap((line): Row[] => { const [date, raw] = line.split(","); const value = Number(raw); return Number.isFinite(value) ? [{ asset: asset.id, timestamp: new Date(`${date}T00:00:00Z`).toISOString(), timezone: "UTC", session: "OFFICIAL_DAILY", interval, open: value, high: value, low: value, close: value, volume: null, source: `FRED:${asset.series}`, completeness: "COMPLETE", quality: "OFFICIAL" }] : []; });
  return resample(daily, interval);
}

async function spotRows(asset: CurrencyIndex, interval: string, basket: string[], stage: Stage): Promise<Row[]> {
  if (!asset.currency) throw new Error("MISSING_CURRENCY");
  const peers = basket.filter((currency) => currency !== asset.currency);
  const series = await Promise.all(peers.map(async (peer) => {
    const symbol = `${asset.currency}${peer}=X`;
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set("interval", yahooInterval(interval)); url.searchParams.set("range", range(interval, stage));
    const response = await fetch(url, { headers: { "user-agent": "SmartFund-Currency-Index/1.0" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`SPOT_HTTP_${response.status}:${symbol}`);
    const body = await response.json() as any; const result = body.chart?.result?.[0]; const quote = result?.indicators?.quote?.[0];
    return (result?.timestamp ?? []).flatMap((epoch: number, index: number) => { const close = quote?.close?.[index]; return close == null || close <= 0 ? [] : [[epoch * 1000, close] as [number, number]]; });
  }));
  const bases = series.map((values) => values[0]?.[1]).filter(Number.isFinite) as number[];
  const byTime = new Map<number, number[]>(); series.forEach((values, component) => values.forEach(([time, value]) => { if (!bases[component]) return; const bucket = Math.floor(time / bucketMs(interval)) * bucketMs(interval); const list = byTime.get(bucket) ?? []; list.push(value / bases[component]); byTime.set(bucket, list); }));
  const raw = [...byTime].sort(([a], [b]) => a - b).flatMap(([time, values]): Row[] => values.length < Math.ceil(peers.length * 0.6) ? [] : [{ asset: asset.id, timestamp: new Date(time).toISOString(), timezone: "UTC", session: "GLOBAL_SPOT", interval, open: 100 * Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length), high: 0, low: 0, close: 0, volume: null, source: "YAHOO_SPOT_COMPONENTS", completeness: values.length === peers.length ? "COMPLETE" : "PARTIAL", quality: "DERIVED", components: values.length }]);
  raw.forEach((row) => { row.high = row.open; row.low = row.open; row.close = row.open; });
  return interval === "4h" ? resample(raw, interval) : raw;
}

function resample(rows: Row[], interval: string): Row[] { if (interval === "1D" || interval === "1m" || interval === "5m" || interval === "15m" || interval === "30m" || interval === "60m") return rows; const size = bucketMs(interval); const grouped = new Map<number, Row>(); for (const row of rows) { const bucket = Math.floor(Date.parse(row.timestamp) / size) * size; const old = grouped.get(bucket); grouped.set(bucket, old ? { ...old, high: Math.max(old.high, row.high), low: Math.min(old.low, row.low), close: row.close, completeness: old.completeness === "COMPLETE" && row.completeness === "COMPLETE" ? "COMPLETE" : "PARTIAL" } : { ...row, timestamp: new Date(bucket).toISOString() }); } return [...grouped.values()]; }
async function archive(work: Work, rows: Row[]) { const path = resolve(root, "archive", work.stage.toLowerCase(), work.interval, `${work.asset}.json.gz`); await atomic(path, gzipSync(JSON.stringify({ version: 1, work, rows }))); return path; }

async function analytics(latest: Record<string, Row>) {
  const values = Object.values(latest); await atomic(paths.latest, `${JSON.stringify(latest, null, 2)}\n`);
  await atomic(paths.comparison, `${JSON.stringify({ generatedAt: new Date().toISOString(), base: 100, values: values.map((row) => ({ asset: row.asset, close: row.close, timestamp: row.timestamp, quality: row.quality })) }, null, 2)}\n`);
  await atomic(paths.technical, `${JSON.stringify({ generatedAt: new Date().toISOString(), policy: "Calculated only when sufficient archived observations exist", indicators: ["SMA20", "SMA50", "EMA20", "RSI14", "MACD_12_26_9"], status: "ARCHIVE_READY" }, null, 2)}\n`);
}

async function main() {
  await lock(); const config = await loadCurrencyIndexConfig(); const active = config.universe.filter((asset) => asset.status === "ACTIVE"); const state = await checkpoint(); const latest: Record<string, Row> = {};
  let dxyCheckedThisProcess = false;
  await atomic(paths.coverage, `${JSON.stringify({ generatedAt: new Date().toISOString(), intervals: config.intervals, capabilities: config.capabilities, universe: config.universe.map((asset) => ({ id: asset.id, status: asset.status, historical: asset.status === "ACTIVE", latest: asset.status === "ACTIVE", intraday: asset.kind === "DERIVED_SPOT", archive: true, retry: true, checkpoint: true, reason: asset.reason ?? null })) }, null, 2)}\n`);
  for (;;) {
    if (!dxyCheckedThisProcess || !state.dxyLatestAt || Date.now() - Date.parse(state.dxyLatestAt) >= config.incrementalIntervalMinutes * 60_000) {
      dxyCheckedThisProcess = true;
      try {
        const result = await syncDxyLatest();
        state.dxyLatestAt = new Date().toISOString();
        await log({ status: "DXY_CANONICAL_SYNCED", ...result });
      } catch (error) {
        state.dxyLatestAt = new Date().toISOString();
        await log({ status: "DXY_LATEST_FAILED", error: error instanceof Error ? error.message : String(error) });
      }
      await save(state);
    }
    const workStage = state.stage; const now = Date.now(); const fresh = active.flatMap((asset) => config.intervals.map((interval): Work => ({ key: `${workStage}:${asset.id}:${interval}`, asset: asset.id, interval, stage: workStage, attempts: 0, nextRunAt: new Date(0).toISOString() })));
    const pending = [...state.retry.filter((work) => Date.parse(work.nextRunAt) <= now), ...fresh.filter((work) => !state.completed[work.key] && !state.retry.some((retry) => retry.key === work.key) && !state.deadLetter.some((dead) => dead.key === work.key))];
    if (!pending.length) { if (workStage === "HISTORICAL") state.stage = "LATEST"; else { state.stage = "INCREMENTAL"; state.cycles += 1; await analytics(latest); } state.completed = {}; await save(state); if (workStage !== "HISTORICAL") await sleep(config.incrementalIntervalMinutes * 60_000); continue; }
      for (const work of pending.slice(0, 6)) { state.current = work.key; await save(state); const asset = active.find((candidate) => candidate.id === work.asset)!; try { const rows = asset.kind === "OFFICIAL" ? await fredRows(asset, work.interval) : await spotRows(asset, work.interval, config.derivedBasket, work.stage); const path = await archive(work, rows); if (rows.at(-1)) latest[asset.id] = rows.at(-1)!; state.completed[work.key] = new Date().toISOString(); state.retry = state.retry.filter((item) => item.key !== work.key); await log({ status: "ARCHIVED", key: work.key, rows: rows.length, path }); } catch (error) { const attempts = work.attempts + 1; state.retry = state.retry.filter((item) => item.key !== work.key); const message = error instanceof Error ? error.message : String(error); if (attempts >= 8) addDeadLetter(state, { ...work, attempts }, message); else state.retry.push({ ...work, attempts, nextRunAt: new Date(Date.now() + Math.min(6 * 3600_000, 30_000 * 2 ** attempts)).toISOString() }); await log({ status: attempts >= 8 ? "DEAD_LETTER" : "RETRY_QUEUED", key: work.key, attempts, error: message }); } await save(state); await sleep(300); }
    await atomic(paths.manifest, `${JSON.stringify({ pid: process.pid, service: config.productionService, stage: state.stage, current: state.current, activeAssets: active.length, registeredAssets: config.universe.length, completed: Object.keys(state.completed).length, retry: state.retry.length, deadLetter: state.deadLetter.length, cycles: state.cycles, updatedAt: state.updatedAt }, null, 2)}\n`);
  }
}

main().catch(async (error) => { await log({ status: "FATAL", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined); process.exitCode = 1; });
