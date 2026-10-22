// One-shot: apply the exact, already-verified 20260925000000_add_etf_official_daily_holdings SQL
// directly (not via `prisma migrate deploy`, since local/DB migration history is known to have
// diverged on ~90 unrelated migrations). Single transaction, no _prisma_migrations touch.
import { Client } from "pg";
import * as fs from "fs";

const sql = fs.readFileSync(
  __dirname + "/../prisma/migrations/20260925000000_add_etf_official_daily_holdings/migration.sql",
  "utf8",
);

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("MIGRATION_APPLIED_OK");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("MIGRATION_FAILED_ROLLED_BACK:", e);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
