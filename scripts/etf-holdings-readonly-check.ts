// READ-ONLY. Confirms whether Phase D's failed transaction left partial data behind.
import { Client } from "pg";

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  try {
    const snap = await client.query("SELECT COUNT(*) c FROM etf_official_daily_snapshots");
    const pos = await client.query("SELECT COUNT(*) c FROM etf_official_daily_positions");
    const orphan = await client.query(
      `SELECT COUNT(*) c FROM etf_official_daily_positions p
       LEFT JOIN etf_official_daily_snapshots s ON s.id = p.snapshot_id WHERE s.id IS NULL`,
    );
    console.log(JSON.stringify({
      snapshot_rows: snap.rows[0].c,
      position_rows: pos.rows[0].c,
      orphan_positions: orphan.rows[0].c,
    }, null, 2));
  } finally {
    await client.end();
  }
}
main();
