// Applies the consensus_feed_items migration directly (bypassing `prisma migrate deploy`, since
// local/DB migration history is known to have diverged — same precedent as the Function 2 round).
// Single transaction, no _prisma_migrations touch.
import { Client } from "pg";
import * as fs from "fs";

async function main() {
  const sql = fs.readFileSync(
    "prisma/migrations/20260927012209_add_consensus_feed_items/migration.sql", "utf8",
  );
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
