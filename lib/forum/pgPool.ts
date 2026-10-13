// Shared raw `pg` Pool for everything under lib/forum/** (the `forum` and `billing` Postgres
// schemas). One pool, reused by membership/db.ts and data/*.ts, instead of each module opening its
// own — avoids needlessly multiplying connections against the pooled DATABASE_URL.

import { Pool } from "pg";

let pool: Pool | null = null;

// Test-only seam: integration tests (lib/forum/data/__tests__) run every statement against ONE real
// transactional client so a single final ROLLBACK guarantees nothing is left behind in production
// tables, per the user's "在 BEGIN...ROLLBACK 中對真實資料表測試，不得留下資料" instruction. Never set
// this outside of a test.
let testOverride: Pick<Pool, "query" | "connect"> | null = null;

export function __setForumPoolOverrideForTests(override: Pick<Pool, "query" | "connect">): void {
  testOverride = override;
}

export function __clearForumPoolOverrideForTests(): void {
  testOverride = null;
}

export function getForumPool(): Pool {
  if (testOverride) return testOverride as Pool;

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 3_000,
      application_name: "forum",
    });
  }
  return pool;
}
