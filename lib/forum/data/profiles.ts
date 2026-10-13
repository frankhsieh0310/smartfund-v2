// forum.profiles data access. Nickname rules: 2-20 characters, case-insensitive uniqueness
// (DB-enforced via a lower(nickname) unique index — see docs/specs/forum-billing-schema-applied.sql),
// and must not match the content filter (no contact info / filtered terms in a nickname either).

import { getForumPool } from "../pgPool.ts";
import { runForumFilter } from "../filter/index.ts";
import type { FilterConfig, StockDirectory } from "../filter/types.ts";

export type ProfileStatus = "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED";

export interface ForumProfile {
  id: string;
  userId: string;
  nickname: string;
  status: ProfileStatus;
}

export class NicknameInvalidError extends Error {}
export class NicknameTakenError extends Error {}

const NICKNAME_PATTERN = /^[\p{L}\p{N}_]{2,20}$/u;

export function validateNicknameShape(nickname: string): void {
  if (!NICKNAME_PATTERN.test(nickname)) {
    throw new NicknameInvalidError("暱稱需為 2-20 個字元，只能使用文字、數字與底線。");
  }
}

export function validateNicknameContent(
  nickname: string,
  filterConfig: FilterConfig,
  stockDirectory: StockDirectory,
): void {
  const verdict = runForumFilter(nickname, filterConfig, stockDirectory);
  if (verdict.action === "BLOCK") {
    throw new NicknameInvalidError("暱稱不能包含聯絡方式或不當用語。");
  }
}

export async function getProfileByUserId(userId: string): Promise<ForumProfile | null> {
  const result = await getForumPool().query<{
    id: string;
    user_id: string;
    nickname: string;
    status: ProfileStatus;
  }>(`SELECT id, user_id, nickname, status FROM forum.profiles WHERE user_id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, userId: row.user_id, nickname: row.nickname, status: row.status };
}

export async function getProfileById(profileId: string): Promise<ForumProfile | null> {
  const result = await getForumPool().query<{
    id: string;
    user_id: string;
    nickname: string;
    status: ProfileStatus;
  }>(`SELECT id, user_id, nickname, status FROM forum.profiles WHERE id = $1`, [profileId]);
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, userId: row.user_id, nickname: row.nickname, status: row.status };
}

/** Creates a profile on first nickname setup. Throws NicknameTakenError on a case-insensitive clash. */
export async function createProfile(userId: string, nickname: string): Promise<ForumProfile> {
  try {
    const result = await getForumPool().query<{ id: string; status: ProfileStatus }>(
      `INSERT INTO forum.profiles (user_id, nickname) VALUES ($1, $2) RETURNING id, status`,
      [userId, nickname],
    );
    const row = result.rows[0]!;
    return { id: row.id, userId, nickname, status: row.status };
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code?: string }).code === "23505") {
      throw new NicknameTakenError("這個暱稱已經有人使用了。");
    }
    throw e;
  }
}

export async function updateNickname(profileId: string, nickname: string): Promise<void> {
  try {
    await getForumPool().query(
      `UPDATE forum.profiles SET nickname = $2, nickname_changed_at = now(), updated_at = now() WHERE id = $1`,
      [profileId, nickname],
    );
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code?: string }).code === "23505") {
      throw new NicknameTakenError("這個暱稱已經有人使用了。");
    }
    throw e;
  }
}

/** Checks for a currently-active suspension (temporary not yet ended, or permanent). */
export async function isCurrentlySuspended(profileId: string): Promise<boolean> {
  const result = await getForumPool().query(
    `SELECT 1 FROM forum.suspensions
     WHERE profile_id = $1 AND (ends_at IS NULL OR ends_at > now())
     LIMIT 1`,
    [profileId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Deletes a forum account at the application layer (decision 9 in the spec): clears all of this
 * profile's posts/replies content and marks the profile DELETED, without a DB-level CASCADE delete,
 * so other users' quotes of this content can still resolve the (now-empty) row and render
 * "此內容已刪除" instead of breaking.
 */
export async function deleteForumAccount(profileId: string): Promise<void> {
  const client = await getForumPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE forum.posts SET title = NULL, body = NULL, status = 'DELETED', deleted_at = now(), updated_at = now() WHERE author_id = $1`,
      [profileId],
    );
    await client.query(
      `UPDATE forum.replies SET body = NULL, status = 'DELETED', deleted_at = now(), updated_at = now() WHERE author_id = $1`,
      [profileId],
    );
    await client.query(`UPDATE forum.profiles SET status = 'DELETED', updated_at = now() WHERE id = $1`, [
      profileId,
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
