// Raw `pg` data access for forum membership — deliberately NOT added to prisma/schema.prisma
// (decision 6 in docs/specs/paid-member-forum-spec.md § 決定紀錄: dedicated `forum` schema, accessed
// via its own pg Pool, isolated from the shared `public` schema Prisma already manages).
//
// IMPORTANT: this queries `forum.memberships`, a table that does not exist yet — it is only defined
// in the DDL draft (docs/specs/forum-schema-draft.sql) pending the user's approval per CLAUDE.md's
// migration-approval rule. Every function here will fail at runtime with a "relation does not exist"
// error until that DDL is reviewed and applied by the user. Do not run these against production before
// then.

import { Pool } from "pg";
import type { MembershipStatus } from "./events.ts";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 3_000,
      application_name: "forum-membership",
    });
  }
  return pool;
}

export interface MembershipRow {
  status: MembershipStatus;
  expiresAt: Date | null;
}

/** Upserts the membership row driven by a RevenueCat webhook event. */
export async function upsertMembershipFromWebhook(params: {
  appUserId: string;
  status: MembershipStatus;
  expiresAt: Date | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO forum.memberships (app_user_id, status, expires_at, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (app_user_id)
     DO UPDATE SET status = EXCLUDED.status, expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [params.appUserId, params.status, params.expiresAt],
  );
}

/** Server-side-authoritative membership lookup — always re-derives ACTIVE vs EXPIRED from expires_at. */
export async function getMembershipStatus(appUserId: string): Promise<MembershipRow | null> {
  const result = await getPool().query<{ status: MembershipStatus; expires_at: Date | null }>(
    `SELECT status, expires_at FROM forum.memberships WHERE app_user_id = $1`,
    [appUserId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const expired = row.expires_at !== null && row.expires_at.getTime() <= Date.now();
  return {
    status: expired ? "EXPIRED" : row.status,
    expiresAt: row.expires_at,
  };
}
