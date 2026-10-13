// Focused storage/diff test: real official data -> canonical snapshot -> generalized storage -> diff, all
// inside a single ROLLBACK transaction against the real DB, against the finalized
// etf_official_daily_snapshots / etf_official_daily_positions schema. No production write, no deploy.
import { Client } from "pg";
import * as dotenv from "dotenv";
const __dirname = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
dotenv.config({ path: __dirname + "/../.env" });

import { NomuraOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/nomura.ts";
import { UpamcOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/upamc.ts";
import { upsertSnapshot, loadFrontendDiff } from "../lib/etf-holdings-engine/storage.ts";
import * as fs from "fs";
import * as path from "path";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION_FAILED: ${msg}`);
}

async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL });
  await c.connect();
  await c.query("SET statement_timeout = 0");
  await c.query("BEGIN");

  const query = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows;

  try {
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "../prisma/migrations/20260925000000_add_etf_official_daily_holdings/migration.sql"),
      "utf8",
    );
    await c.query(migrationSql);

    const report: Record<string, unknown> = {};

    // ---- Nomura (00980A): two real official dates ----
    {
      const dates = await NomuraOfficialPcfAdapter.listAvailableDates!("00980A");
      const [d2, d1] = dates; // newest first -> d1 older, d2 newer
      const snap1 = await NomuraOfficialPcfAdapter.fetchSnapshot("00980A", d1);
      const snap2 = await NomuraOfficialPcfAdapter.fetchSnapshot("00980A", d2);

      const w1 = await upsertSnapshot(query, snap1);
      const w2a = await upsertSnapshot(query, snap2);
      const w2b = await upsertSnapshot(query, snap2); // rerun day 2

      const countRows = await query(`SELECT count(*)::int n FROM etf_official_daily_snapshots WHERE etf_code = $1`, ["00980A"]);
      report["NOMURA_SNAPSHOT_COUNT"] = countRows[0].n;
      report["NOMURA_DAY2_SECOND_RUN_WAS_NEW"] = w2b.wasNew;
      report["NOMURA_DAY2_SAME_SNAPSHOT_ID"] = w2a.snapshotId === w2b.snapshotId;

      assert(countRows[0].n === 2, `expected 2 stored snapshots for 00980A, got ${countRows[0].n}`);
      assert(w2b.wasNew === false, "day-2 rerun should not be treated as new");
      assert(w2a.snapshotId === w2b.snapshotId, "day-2 rerun should upsert the same snapshot row, not create a duplicate");
    }

    // ---- UPAMC (00981A): two real official dates already confirmed (09/23, 09/24) ----
    {
      const snap1 = await UpamcOfficialPcfAdapter.fetchSnapshot("00981A", "115/09/24"); // -> dataDate 2026-09-23
      const snap2 = await UpamcOfficialPcfAdapter.fetchSnapshot("00981A", "115/09/29"); // -> dataDate 2026-09-24

      await upsertSnapshot(query, snap1);
      const w2a = await upsertSnapshot(query, snap2);
      const w2b = await upsertSnapshot(query, snap2); // rerun day 2

      const countRows = await query(`SELECT count(*)::int n FROM etf_official_daily_snapshots WHERE etf_code = $1`, ["00981A"]);
      const dup = await query(
        `SELECT etf_code, data_date, count(*)::int n FROM etf_official_daily_snapshots WHERE etf_code = $1 GROUP BY etf_code, data_date HAVING count(*) > 1`,
        ["00981A"],
      );

      assert(countRows[0].n === 2, `expected 2 stored snapshots for 00981A, got ${countRows[0].n}`);
      assert(dup.length === 0, "found duplicate snapshot rows for the same (etf_code, data_date)");
      assert(w2b.wasNew === false, "day-2 rerun should not be treated as new");
      assert(w2a.snapshotId === w2b.snapshotId, "day-2 rerun should upsert the same snapshot row");

      const diff = await loadFrontendDiff(query, "00981A");
      report["UPAMC_SNAPSHOT_COUNT"] = countRows[0].n;
      report["UPAMC_DAY2_SECOND_RUN_DUPLICATE"] = dup.length;
      report["00981A_diff_summary"] = {
        dateFrom: diff.dateFrom, dateTo: diff.dateTo,
        added: diff.addedCount, removed: diff.removedCount, increased: diff.increasedCount,
        decreased: diff.decreasedCount, unchanged: diff.unchangedCount,
      };
      const tsmc = diff.changes.find((x) => x.code === "2330");
      report["2330_check"] = tsmc;

      assert(diff.addedCount === 0, `expected ADDED=0, got ${diff.addedCount}`);
      assert(diff.removedCount === 0, `expected REMOVED=0, got ${diff.removedCount}`);
      assert(!!tsmc, "2330 TSMC missing from diff");
      assert(tsmc!.action === "DECREASED", `expected 2330 action DECREASED, got ${tsmc!.action}`);
      assert(tsmc!.positionUnit === "SHARES", `expected 2330 positionUnit SHARES, got ${tsmc!.positionUnit}`);
      assert(tsmc!.changeLots === -400, `expected 2330 changeLots -400 (equity -> lots), got ${tsmc!.changeLots}`);
      assert(tsmc!.previousAmount === 11864000, `expected 2330 previousAmount 11864000 shares, got ${tsmc!.previousAmount}`);
      assert(tsmc!.currentAmount === 11464000, `expected 2330 currentAmount 11464000 shares, got ${tsmc!.currentAmount}`);
    }

    console.log(JSON.stringify(report, null, 2));
    console.log("ALL ASSERTIONS PASSED");
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
}

main().catch((e) => { console.error("POC_FAILED:", e); process.exit(1); });
