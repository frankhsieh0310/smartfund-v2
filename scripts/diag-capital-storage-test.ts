// Focused storage test only — 00860B / 009823, inside a transaction that is always ROLLED BACK.
// No permanent DB write. Confirms upsertSnapshot() no longer hits "ON CONFLICT DO UPDATE command
// cannot affect row a second time" for these two, and that no real row was dropped.
import { Client } from "pg";
import { upsertSnapshot } from "../lib/etf-holdings-engine/storage.ts";
import { CapitalOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/capital.ts";

const TARGETS = ["00860B", "009823"];

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  const query = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows;
  try {
    await client.query("BEGIN");
    for (const t of TARGETS) {
      const snap = await CapitalOfficialPcfAdapter.fetchSnapshot(t);
      const { snapshotId } = await upsertSnapshot(query, snap);
      const { rows } = await client.query(
        `SELECT COUNT(*) c FROM etf_official_daily_positions WHERE snapshot_id = $1`,
        [snapshotId],
      );
      console.log(JSON.stringify({
        ticker: t, storageTest: "PASS", fetchedPositions: snap.positions.length,
        storedPositions: Number(rows[0].c),
        positionCountMatches: Number(rows[0].c) === snap.positions.length,
      }));
    }
  } catch (e) {
    console.log(JSON.stringify({ storageTest: "FAIL", error: e instanceof Error ? e.message : String(e) }));
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
main();
