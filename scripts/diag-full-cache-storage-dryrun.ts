// Full cached storage dry-run — all 331 snapshots from the existing fetch cache (no re-fetch), inside
// ONE transaction that is always ROLLED BACK. No permanent write.
import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";
import { upsertSnapshot } from "../lib/etf-holdings-engine/storage.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE_PATH = path.join(ROOT, "runtime", "etf-holdings-fetch-cache", "latest-fetch-batch.json");

async function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  const query = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows;

  let pass = 0;
  const failures: any[] = [];
  await client.query("BEGIN");
  try {
    for (const r of cache.results) {
      if (!r.snapshot) { failures.push({ ticker: r.ticker, error: "no cached snapshot" }); continue; }
      try {
        const { snapshotId } = await upsertSnapshot(query, r.snapshot);
        const { rows } = await client.query(`SELECT COUNT(*) c FROM etf_official_daily_positions WHERE snapshot_id = $1`, [snapshotId]);
        if (Number(rows[0].c) !== r.snapshot.positions.length) {
          failures.push({ ticker: r.ticker, error: `row count mismatch: fetched ${r.snapshot.positions.length}, stored ${rows[0].c}` });
        } else {
          pass++;
        }
      } catch (e) {
        failures.push({ ticker: r.ticker, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    await client.query("ROLLBACK");
  }

  const snapAfter = await client.query(`SELECT COUNT(*) c FROM etf_official_daily_snapshots`);
  const posAfter = await client.query(`SELECT COUNT(*) c FROM etf_official_daily_positions`);
  await client.end();

  console.log(JSON.stringify({
    CACHED_STORAGE_TARGET: cache.results.length,
    CACHED_STORAGE_PASS: pass,
    CACHED_STORAGE_FAIL: failures.length,
    failures,
    ROLLBACK_CONFIRMED: snapAfter.rows[0].c === "0" && posAfter.rows[0].c === "0",
    snapshot_rows_after_rollback: snapAfter.rows[0].c,
    position_rows_after_rollback: posAfter.rows[0].c,
  }, null, 2));
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
