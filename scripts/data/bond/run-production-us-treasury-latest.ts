import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const requireFromProject = createRequire(path.resolve(process.cwd(), "package.json"));
const { Client } = requireFromProject("pg") as typeof import("pg");

const ROOT = path.resolve("runtime", "bond", "us-treasury-latest");
const CHECKPOINT = path.join(ROOT, "checkpoint.json");
const LOCK = path.join(ROOT, "single-writer.lock");
const SOURCE = "US_TREASURY_DAILY_PAR_YIELD_CURVE";
const SOURCE_URL = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/";
const YEAR = new Date().getUTCFullYear();
const FEED = `${SOURCE_URL}pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${YEAR}`;
const TENORS = [
  { field: "BC_2YEAR", tenor: "2Y", symbol: "US2Y" },
  { field: "BC_5YEAR", tenor: "5Y", symbol: "US5Y" },
  { field: "BC_10YEAR", tenor: "10Y", symbol: "US10Y" },
  { field: "BC_30YEAR", tenor: "30Y", symbol: "US30Y" },
] as const;

type Checkpoint = { owner?: string; lastObservationDate?: string; lastSuccessfulRun?: string; nextRunAt?: string; runs?: number };

async function atomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function priorCheckpoint(): Promise<Checkpoint> {
  try { return JSON.parse(await readFile(CHECKPOINT, "utf8")) as Checkpoint; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function acquire(): Promise<Awaited<ReturnType<typeof open>>> {
  await mkdir(ROOT, { recursive: true });
  try {
    const handle = await open(LOCK, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, owner: "DESKTOP_US_TREASURY_LATEST", startedAt: new Date().toISOString() })}\n`);
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const lock = JSON.parse(await readFile(LOCK, "utf8")) as { pid?: number };
    if (lock.pid && alive(lock.pid)) throw new Error(`US_TREASURY_LATEST_SINGLE_WRITER:${lock.pid}`);
    await rm(LOCK, { force: true });
    return acquire();
  }
}

function latestRows(xml: string): Array<{ symbol: string; tenor: string; date: string; value: number }> {
  const rows = [...xml.matchAll(/<m:properties>([\s\S]*?)<\/m:properties>/g)].flatMap((entry) => {
    const values: Record<string, string> = {};
    for (const field of entry[1].matchAll(/<d:([A-Z0-9_]+)(?:\s[^>]*)?>([^<]*)<\/d:\1>/g)) values[field[1]] = field[2];
    const date = values.NEW_DATE?.slice(0, 10);
    if (!date) return [];
    return TENORS.flatMap(({ field, tenor, symbol }) => {
      const value = Number(values[field]);
      return Number.isFinite(value) ? [{ symbol, tenor, date, value }] : [];
    });
  });
  return TENORS.map(({ symbol }) => rows.filter((row) => row.symbol === symbol).sort((a, b) => b.date.localeCompare(a.date))[0]).filter(Boolean);
}

async function main(): Promise<void> {
  const lock = await acquire();
  const prior = await priorCheckpoint();
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL_REQUIRED");
  const url = new URL(raw); url.searchParams.set("pgbouncer", "true"); url.searchParams.set("connection_limit", "1");
  const client = new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000, query_timeout: 20_000, application_name: "desktop-us-treasury-latest" });
  try {
    const response = await fetch(FEED, { headers: { Accept: "application/xml", "User-Agent": "SmartFund US Treasury latest/1.0" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`US_TREASURY_HTTP_${response.status}`);
    const rows = latestRows(await response.text());
    if (rows.length !== TENORS.length) throw new Error(`US_TREASURY_LATEST_INCOMPLETE:${rows.length}/${TENORS.length}`);
    await client.connect();
    await client.query("BEGIN");
    let inserted = 0;
    for (const row of rows) {
      const master = await client.query<{ id: string; name: string; currency: string | null; latest_date: string | null }>("SELECT id,name,currency,latest_date::text FROM market_master WHERE asset_type='BOND' AND symbol=$1 FOR UPDATE", [row.symbol]);
      if (master.rowCount !== 1) throw new Error(`US_TREASURY_MASTER_NOT_FOUND:${row.symbol}`);
      const existed = await client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM market_data WHERE symbol=$1 AND date=$2::date) exists", [row.symbol, row.date]);
      const previous = await client.query<{ close: string }>("SELECT close::text FROM market_data WHERE symbol=$1 AND date<$2::date ORDER BY date DESC LIMIT 1", [row.symbol, row.date]);
      const previousValue = Number(previous.rows[0]?.close);
      const change = Number.isFinite(previousValue) ? row.value - previousValue : null;
      const changePct = Number.isFinite(previousValue) && previousValue !== 0 ? change! / previousValue * 100 : null;
      await client.query(`INSERT INTO market_data(id,symbol,name,type,date,close,change_pts,change_pct,currency,source)
        VALUES($1,$2,$3,'BOND',$4::date,$5,$6,$7,$8,$9)
        ON CONFLICT(symbol,date) DO UPDATE SET close=EXCLUDED.close,change_pts=EXCLUDED.change_pts,change_pct=EXCLUDED.change_pct,currency=EXCLUDED.currency,source=EXCLUDED.source`,
        [randomUUID(), row.symbol, master.rows[0].name, row.date, row.value, change, changePct, master.rows[0].currency ?? "USD", SOURCE]);
      await client.query(`INSERT INTO market_history(id,symbol,date,open,high,low,close,volume)
        VALUES($1,$2,$3::date,$4,$4,$4,$4,NULL)
        ON CONFLICT(symbol,date) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close`, [randomUUID(), row.symbol, row.date, row.value]);
      await client.query("UPDATE market_master SET latest_close=$2,latest_date=$3::date,latest_change=$4,latest_change_pct=$5,updated_at=NOW() WHERE id=$1 AND (latest_date IS NULL OR latest_date<=$3::date)", [master.rows[0].id, row.value, row.date, change, changePct]);
      if (!existed.rows[0]?.exists) inserted += 1;
    }
    await client.query("COMMIT");
    const latest = rows.map((row) => row.date).sort().at(-1)!;
    const now = new Date();
    await atomic(CHECKPOINT, { ...prior, owner: "DESKTOP_US_TREASURY_LATEST", managedBy: "GLOBAL_BOND_DESKTOP_SUPERVISOR", status: "SCHEDULED_WAIT", pid: null, lastObservationDate: latest, lastSuccessfulRun: now.toISOString(), nextRunAt: new Date(now.getTime() + 15 * 60_000).toISOString(), runs: (prior.runs ?? 0) + 1, inserted, source: SOURCE, sourceUrl: SOURCE_URL, tenors: Object.fromEntries(rows.map((row) => [row.tenor, row.date])) });
    console.log(JSON.stringify({ status: "PASS", owner: "DESKTOP_US_TREASURY_LATEST", inserted, latest, rows }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
    await lock.close();
    await rm(LOCK, { force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
