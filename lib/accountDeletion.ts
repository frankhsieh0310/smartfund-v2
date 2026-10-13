// Full account deletion (Apple App Store Review Guideline 5.1.1(v)). Deletes the SmartMatch account
// itself and all personal data, not just the forum content (contrast with
// lib/forum/data/profiles.ts's deleteForumAccount, which only clears discussion-board content for a
// standalone "leave the forum" action — this module is the superset used by "delete my account").
//
// KNOWN BLOCKER (VERIFIED against the live schema, 2026-10-13 — see docs/specs/forum-profiles-fk-fix-draft.sql):
// forum.profiles.user_id is `ON DELETE CASCADE` from public.users, but forum.posts.author_id and
// forum.replies.author_id reference forum.profiles(id) with NO onDelete action (defaults to RESTRICT
// in Postgres). So deleting a user who has ever authored a forum post/reply will currently fail with
// a foreign-key violation, because Postgres's cascade tries to delete the forum.profiles row while
// posts/replies still reference it. The fix is a schema change (make forum.profiles.user_id nullable,
// ON DELETE SET NULL) that is drafted but NOT applied pending approval. Today this has zero real-world
// impact because forum.posts/forum.replies are still empty (the feature hasn't launched), but it must
// be fixed before launch. deleteOwnAccount() detects this specific failure and surfaces it clearly
// instead of letting a raw DB error reach the client.

import { prisma } from "@/lib/prisma";
import { getForumPool } from "@/lib/forum/pgPool";
import { getProfileByUserId, deleteForumAccount as clearForumContent } from "@/lib/forum/data/profiles";

export class ForumContentBlocksAccountDeletionError extends Error {}

export interface AccountDeletionResult {
  deletedUserId: string;
  forumContentCleared: boolean;
  supabaseAuthIdentityDeleted: boolean;
}

/**
 * Deletes a user's SmartMatch account and all associated personal data:
 *  - public.users row itself, which Postgres CASCADEs into (VERIFIED against the live DB's FK
 *    definitions, 2026-10-13): portfolios, watchlists, notifications, notification_profiles (push
 *    tokens/preferences), alerts, favorites, strategies, strategy_favorites, user_criteria,
 *    investor_questionnaires, saved_filters, audit_logs, workspaces, billing.memberships.
 *  - search_logs.user_id is SET NULL (the search text itself is kept, de-identified).
 *  - forum content: cleared at the application layer FIRST (title/body wiped, status DELETED on
 *    forum.posts/forum.replies; forum.profiles row marked DELETED) via clearForumContent(), exactly
 *    like the standalone "leave the forum" flow, so other users' quotes keep resolving to a
 *    "此內容已刪除" placeholder instead of a dangling reference.
 *  - forum.moderation_log rows that reference this user's past actions as a moderation TARGET are
 *    deliberately NOT touched — they contain no content or PII (only action type + opaque target
 *    UUID + actor ref), consistent with the week-1 decision that this table is append-only and never
 *    scrubbed by account/content deletion.
 *
 * Does NOT cancel any Apple/Google subscription — the caller must have already told the user to
 * cancel it themselves in the App Store/Play Store (deleting the account does not stop billing).
 */
export async function deleteOwnAccount(userId: string): Promise<AccountDeletionResult> {
  const forumProfile = await getProfileByUserId(userId);
  let forumContentCleared = false;

  if (forumProfile && forumProfile.status !== "DELETED") {
    await clearForumContent(forumProfile.id);
    forumContentCleared = true;
  }

  try {
    await prisma.user.delete({ where: { id: userId } });
  } catch (e) {
    if (isForeignKeyViolation(e) && forumProfile) {
      throw new ForumContentBlocksAccountDeletionError(
        "這個帳號曾在討論區發文，目前的資料庫結構還無法讓你完整刪除帳號（已清空討論區文章內容，但帳號本身尚未刪除）。" +
          "這是已知的待修正項目，請聯絡客服信箱協助處理。",
      );
    }
    throw e;
  }

  const supabaseAuthIdentityDeleted = await tryDeleteSupabaseAuthIdentity(userId);

  return { deletedUserId: userId, forumContentCleared, supabaseAuthIdentityDeleted };
}

function isForeignKeyViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2003";
}

/**
 * Best-effort deletion of the underlying Supabase Auth identity, so the person can't just log back
 * in with the same email after "deleting" their account. Requires SUPABASE_SERVICE_ROLE_KEY, which
 * is NOT currently configured anywhere in this project (VERIFIED — grepped the codebase and env,
 * 2026-10-13). Until the user adds it in Vercel, this silently does nothing (the public.users row and
 * all app data are still fully deleted) and the caller is told so via the returned boolean, rather
 * than failing the whole deletion over a missing optional credential.
 */
async function tryDeleteSupabaseAuthIdentity(supabaseUserId: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return false;

  const response = await fetch(`${url}/auth/v1/admin/users/${supabaseUserId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  });
  return response.ok;
}

/** Read-only inventory used by the DELETE route to tell the user what will happen before they confirm. */
export async function describeAccountDeletionImpact(userId: string) {
  const forumProfile = await getProfileByUserId(userId);
  let forumPostCount = 0;
  let forumReplyCount = 0;
  if (forumProfile) {
    const result = await getForumPool().query<{ posts: string; replies: string }>(
      `SELECT
         (SELECT count(*) FROM forum.posts WHERE author_id = $1) AS posts,
         (SELECT count(*) FROM forum.replies WHERE author_id = $1) AS replies`,
      [forumProfile.id],
    );
    forumPostCount = Number(result.rows[0]?.posts ?? 0);
    forumReplyCount = Number(result.rows[0]?.replies ?? 0);
  }
  return { hasForumProfile: !!forumProfile, forumPostCount, forumReplyCount };
}
