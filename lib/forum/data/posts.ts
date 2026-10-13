import { getForumPool } from "../pgPool.ts";
import { runForumFilter } from "../filter/index.ts";
import type { FilterConfig, StockDirectory } from "../filter/types.ts";
import {
  assertMinimumIntervalElapsed,
  assertNoDuplicatePost,
  assertUnderDailyPostLimit,
  isFirstEverPost,
} from "./rateLimits.ts";
import { notifyAdmin, recordBlockedAttempt } from "./moderation.ts";

export class ContentBlockedError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join(" "));
    this.reasons = reasons;
  }
}

export type PostStatus = "PENDING" | "PUBLISHED" | "HIDDEN" | "DELETED";

export interface ForumPost {
  id: string;
  channelId: string;
  authorId: string;
  title: string | null;
  body: string | null;
  status: PostStatus;
  reportCount: number;
  createdAt: Date;
}

function rowToPost(row: {
  id: string;
  channel_id: string;
  author_id: string;
  title: string | null;
  body: string | null;
  status: PostStatus;
  report_count: number;
  created_at: Date;
}): ForumPost {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    title: row.title,
    body: row.body,
    status: row.status,
    reportCount: row.report_count,
    createdAt: row.created_at,
  };
}

/** Posts visible to end users: PUBLISHED (and PENDING only to their own author, handled by the caller). */
export async function listPublishedPosts(channelId: string, limit = 50): Promise<ForumPost[]> {
  const result = await getForumPool().query(
    `SELECT id, channel_id, author_id, title, body, status, report_count, created_at
     FROM forum.posts WHERE channel_id = $1 AND status = 'PUBLISHED'
     ORDER BY created_at DESC LIMIT $2`,
    [channelId, limit],
  );
  return result.rows.map(rowToPost);
}

export async function getPostById(postId: string): Promise<ForumPost | null> {
  const result = await getForumPool().query(
    `SELECT id, channel_id, author_id, title, body, status, report_count, created_at
     FROM forum.posts WHERE id = $1`,
    [postId],
  );
  return result.rows[0] ? rowToPost(result.rows[0]) : null;
}

export interface CreatePostParams {
  profileId: string;
  channelId: string;
  title: string;
  body: string;
  filterConfig: FilterConfig;
  stockDirectory: StockDirectory;
}

/**
 * Creates a main post, enforcing (in order): minimum post interval, daily post limit, duplicate
 * content, and the content filter. A first-ever post from this profile is always created as PENDING
 * (pre-moderation) regardless of the filter verdict, per the spec's "新會員第一篇主文先審後發" rule.
 */
export async function createPost(params: CreatePostParams): Promise<ForumPost> {
  await assertMinimumIntervalElapsed(params.profileId);
  await assertUnderDailyPostLimit(params.profileId);
  await assertNoDuplicatePost(params.profileId, params.body);

  const combinedText = `${params.title}\n${params.body}`;
  const verdict = runForumFilter(combinedText, params.filterConfig, params.stockDirectory);

  if (verdict.action === "BLOCK") {
    await recordBlockedAttempt({
      profileId: params.profileId,
      channelId: params.channelId,
      matchedCategory: verdict.reasons[0]!.category === "fraud_redirect" ? "FRAUD_REDIRECT"
        : verdict.reasons[0]!.category === "stock_trading_advice" ? "STOCK_ADVICE" : "PROFANITY",
      matchedTermRef: verdict.reasons[0]!.matched,
      rawContent: combinedText,
    });
    throw new ContentBlockedError(verdict.reasons.map((r) => r.message));
  }

  if (verdict.action === "NOTIFY") {
    notifyAdmin("Post passed with a NOTIFY-level filter hit", { profileId: params.profileId, reasons: verdict.reasons });
  }

  const isFirstPost = await isFirstEverPost(params.profileId);
  const status: PostStatus = isFirstPost ? "PENDING" : "PUBLISHED";

  const result = await getForumPool().query(
    `INSERT INTO forum.posts (channel_id, author_id, title, body, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, channel_id, author_id, title, body, status, report_count, created_at`,
    [params.channelId, params.profileId, params.title, params.body, status],
  );
  return rowToPost(result.rows[0]!);
}

export async function editPost(
  postId: string,
  authorId: string,
  body: string,
  filterConfig: FilterConfig,
  stockDirectory: StockDirectory,
): Promise<ForumPost> {
  const verdict = runForumFilter(body, filterConfig, stockDirectory);
  if (verdict.action === "BLOCK") {
    await recordBlockedAttempt({
      profileId: authorId,
      channelId: null,
      matchedCategory: verdict.reasons[0]!.category === "fraud_redirect" ? "FRAUD_REDIRECT"
        : verdict.reasons[0]!.category === "stock_trading_advice" ? "STOCK_ADVICE" : "PROFANITY",
      matchedTermRef: verdict.reasons[0]!.matched,
      rawContent: body,
    });
    throw new ContentBlockedError(verdict.reasons.map((r) => r.message));
  }
  if (verdict.action === "NOTIFY") {
    notifyAdmin("Post edit passed with a NOTIFY-level filter hit", { postId, reasons: verdict.reasons });
  }

  const result = await getForumPool().query(
    `UPDATE forum.posts SET body = $3, updated_at = now()
     WHERE id = $1 AND author_id = $2 AND status != 'DELETED'
     RETURNING id, channel_id, author_id, title, body, status, report_count, created_at`,
    [postId, authorId, body],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Post not found or not owned by this author.");
  return rowToPost(row);
}

/** Author-initiated deletion of a single post (distinct from whole-account deletion). */
export async function deleteOwnPost(postId: string, authorId: string): Promise<void> {
  await getForumPool().query(
    `UPDATE forum.posts SET title = NULL, body = NULL, status = 'DELETED', deleted_at = now(), updated_at = now()
     WHERE id = $1 AND author_id = $2`,
    [postId, authorId],
  );
}
