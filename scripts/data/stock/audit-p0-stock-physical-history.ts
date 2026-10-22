import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client } from "pg";

const universe = 80_944, output = resolve("runtime/p0-repair-board/stock-physical-history.json");
type Row = Record<string, unknown>;
const pct = (n: number) => Number((n / universe * 100).toFixed(4));
async function atomic(value: unknown) {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  for (let attempt = 0; ; attempt++) try { await rename(temporary, output); return; } catch (error) {
    if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt === 4) throw error;
    await new Promise((done) => setTimeout(done, 40 * (attempt + 1)));
  }
}
async function scalar(db: Client, sql: string) { return Number((await db.query<Row>(sql)).rows[0].value); }
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  const db = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 120_000, query_timeout: 130_000 });
  await db.connect();
  try {
    await db.query("BEGIN READ ONLY");
    // close and date are NOT NULL in production, so these are valid rows and the
    // (stock_id,date) index can satisfy every probe without a history-table scan.
    const present = await scalar(db, `SELECT count(*) FILTER(WHERE EXISTS(SELECT 1 FROM stock_history h WHERE h.stock_id=s.id))::int value FROM stocks s`);
    const usable = await scalar(db, `SELECT count(*) FILTER(WHERE EXISTS(SELECT 1 FROM (SELECT h.date FROM stock_history h WHERE h.stock_id=s.id ORDER BY h.date OFFSET 29 LIMIT 1) q))::int value FROM stocks s`);
    const bounds = (await db.query<Row>(`SELECT min(x.first_date)::text earliest,max(x.last_date)::text latest,count(*) FILTER(WHERE x.last_date>=CURRENT_DATE-INTERVAL '4 days')::int current FROM stocks s CROSS JOIN LATERAL(SELECT (SELECT h.date FROM stock_history h WHERE h.stock_id=s.id ORDER BY h.date LIMIT 1) first_date,(SELECT h.date FROM stock_history h WHERE h.stock_id=s.id ORDER BY h.date DESC LIMIT 1) last_date)x`)).rows[0];
    const current = Number(bounds.current);
    const storage = (await db.query<Row>(`SELECT c.reltuples::bigint estimated_rows,c.relkind,c.relispartition,(SELECT count(*)::int FROM pg_constraint WHERE conrelid=c.oid AND contype='f') foreign_keys,(SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND tablename='stock_history' AND indexdef ILIKE '%UNIQUE%stock_id%date%') unique_stock_date_indexes FROM pg_class c WHERE c.oid='public.stock_history'::regclass`)).rows[0];
    await db.query("COMMIT");
    const heartbeat = await readFile("runtime/global-stock-price-history/heartbeat.json", "utf8").then(JSON.parse).catch(() => ({}));
    const board = { generatedAt: new Date().toISOString(), evidenceMethod: "EXACT_PER_STOCK_INDEX_PROBES_NO_HISTORY_FULL_SCAN", universe,
      historyPresent: { numerator: present, denominator: universe, percent: pct(present), definition: "at least one valid physical stock_history row" },
      historyUsable: { numerator: usable, denominator: universe, percent: pct(usable), definition: "at least 30 valid physical stock_history rows" },
      historyCurrent: { numerator: current, denominator: universe, percent: pct(current), definition: "latest valid physical row within 4 calendar days" },
      earliestHistory: bounds.earliest, latestHistory: bounds.latest, estimatedHistoryRows: Number(storage.estimated_rows),
      storage: { relkind: storage.relkind, partitioned: storage.relispartition, foreignKeys: storage.foreign_keys, uniqueStockDateIndexes: storage.unique_stock_date_indexes },
      runtime: { state: heartbeat.state, pid: heartbeat.pid, lastSuccess: heartbeat.lastSuccess, nextRunAt: heartbeat.nextRunAt, checkpoint: heartbeat.checkpoint, rowsAdded: heartbeat.rows ?? heartbeat.ohlcvRowsAdded, pending: heartbeat.pending ?? heartbeat.noHistory } };
    await atomic(board); console.log(JSON.stringify({ output, ...board }, null, 2));
  } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; } finally { await db.end(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
