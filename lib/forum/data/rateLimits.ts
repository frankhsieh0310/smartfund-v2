// Posting-frequency limits (decision in the user's week-2 instructions):
//   - main posts: 5 per author per rolling 24h
//   - replies: 30 per author per rolling 24h
//   - minimum 60 seconds between ANY two posts/replies by the same author
//   - identical content (same author, same normalized body) within a rolling 24h is blocked
//
// A rolling 24h window (not a calendar-day reset) is used throughout for consistency with the
// filter engine's own "same-user repeat-blocked-attempt" window and because it can't be gamed by
// posting just before/after local midnight.

import { getForumPool } from "../pgPool.ts";

export class RateLimitedError extends Error {}
export class DuplicateContentError extends Error {}

const MAIN_POST_DAILY_LIMIT = 5;
const REPLY_DAILY_LIMIT = 30;
const MIN_SECONDS_BETWEEN_POSTS = 60;

async function mostRecentActivityAt(profileId: string): Promise<Date | null> {
  const result = await getForumPool().query<{ latest: Date | null }>(
    `SELECT greatest(
        (SELECT max(created_at) FROM forum.posts WHERE author_id = $1),
        (SELECT max(created_at) FROM forum.replies WHERE author_id = $1)
      ) AS latest`,
    [profileId],
  );
  return result.rows[0]?.latest ?? null;
}

export async function assertMinimumIntervalElapsed(profileId: string): Promise<void> {
  const latest = await mostRecentActivityAt(profileId);
  if (!latest) return;
  const secondsSince = (Date.now() - latest.getTime()) / 1000;
  if (secondsSince < MIN_SECONDS_BETWEEN_POSTS) {
    throw new RateLimitedError(
      `發文間隔太短，請在 ${Math.ceil(MIN_SECONDS_BETWEEN_POSTS - secondsSince)} 秒後再試一次。`,
    );
  }
}

export async function assertUnderDailyPostLimit(profileId: string): Promise<void> {
  const result = await getForumPool().query<{ count: string }>(
    `SELECT count(*) FROM forum.posts WHERE author_id = $1 AND created_at > now() - interval '24 hours'`,
    [profileId],
  );
  const count = Number(result.rows[0]?.count ?? 0);
  if (count >= MAIN_POST_DAILY_LIMIT) {
    throw new RateLimitedError(`已達每日主文發文上限（${MAIN_POST_DAILY_LIMIT} 篇），請明天再發文。`);
  }
}

export async function assertUnderDailyReplyLimit(profileId: string): Promise<void> {
  const result = await getForumPool().query<{ count: string }>(
    `SELECT count(*) FROM forum.replies WHERE author_id = $1 AND created_at > now() - interval '24 hours'`,
    [profileId],
  );
  const count = Number(result.rows[0]?.count ?? 0);
  if (count >= REPLY_DAILY_LIMIT) {
    throw new RateLimitedError(`已達每日回覆上限（${REPLY_DAILY_LIMIT} 則），請明天再回覆。`);
  }
}

function normalizeForDuplicateCheck(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function assertNoDuplicatePost(profileId: string, body: string): Promise<void> {
  const normalized = normalizeForDuplicateCheck(body);
  const result = await getForumPool().query<{ body: string | null }>(
    `SELECT body FROM forum.posts
     WHERE author_id = $1 AND created_at > now() - interval '24 hours' AND body IS NOT NULL`,
    [profileId],
  );
  const isDuplicate = result.rows.some((row) => row.body !== null && normalizeForDuplicateCheck(row.body) === normalized);
  if (isDuplicate) {
    throw new DuplicateContentError("這篇內容與你 24 小時內發過的文章重複，請修改後再發表。");
  }
}

export async function assertNoDuplicateReply(profileId: string, body: string): Promise<void> {
  const normalized = normalizeForDuplicateCheck(body);
  const result = await getForumPool().query<{ body: string | null }>(
    `SELECT body FROM forum.replies
     WHERE author_id = $1 AND created_at > now() - interval '24 hours' AND body IS NOT NULL`,
    [profileId],
  );
  const isDuplicate = result.rows.some((row) => row.body !== null && normalizeForDuplicateCheck(row.body) === normalized);
  if (isDuplicate) {
    throw new DuplicateContentError("這則回覆與你 24 小時內發過的內容重複，請修改後再發表。");
  }
}

/** Whether this is the author's very first main post ever (pre-moderation gate). */
export async function isFirstEverPost(profileId: string): Promise<boolean> {
  const result = await getForumPool().query<{ count: string }>(
    `SELECT count(*) FROM forum.posts WHERE author_id = $1`,
    [profileId],
  );
  return Number(result.rows[0]?.count ?? 0) === 0;
}
