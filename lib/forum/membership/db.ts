// Raw `pg` data access for billing membership — deliberately NOT added to prisma/schema.prisma
// (decision 6 in docs/specs/paid-member-forum-spec.md § 決定紀錄: dedicated schema, accessed via a
// shared pg Pool, isolated from the `public` schema Prisma already manages).
//
// Queries `billing.memberships` (applied 2026-10-13 — see docs/specs/forum-billing-schema-applied.sql;
// moved here from the original `forum.memberships` draft per the user's decision, since other paid
// features such as dividend reminders will also read this table).

import { getForumPool } from "../pgPool.ts";
import type { MembershipStatus } from "./events.ts";

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
  await getForumPool().query(
    `INSERT INTO billing.memberships (app_user_id, status, expires_at, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (app_user_id)
     DO UPDATE SET status = EXCLUDED.status, expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [params.appUserId, params.status, params.expiresAt],
  );
}

/** Server-side-authoritative membership lookup — always re-derives ACTIVE vs EXPIRED from expires_at. */
export async function getMembershipStatus(appUserId: string): Promise<MembershipRow | null> {
  const result = await getForumPool().query<{ status: MembershipStatus; expires_at: Date | null }>(
    `SELECT status, expires_at FROM billing.memberships WHERE app_user_id = $1`,
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
