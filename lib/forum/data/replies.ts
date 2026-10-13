import { getForumPool } from "../pgPool.ts";
import { runForumFilter } from "../filter/index.ts";
import type { FilterConfig, StockDirectory } from "../filter/types.ts";
import { assertMinimumIntervalElapsed, assertNoDuplicateReply, assertUnderDailyReplyLimit } from "./rateLimits.ts";
import { notifyAdmin, recordBlockedAttempt } from "./moderation.ts";
import { ContentBlockedError } from "./posts.ts";

export type ReplyStatus = "PUBLISHED" | "HIDDEN" | "DELETED";

export interface ForumReply {
  id: string;
  postId: string;
  authorId: string;
  body: string | null;
  status: ReplyStatus;
  reportCount: number;
  createdAt: Date;
}

function rowToReply(row: {
  id: string;
  post_id: string;
  author_id: string;
  body: string | null;
  status: ReplyStatus;
  report_count: number;
  created_at: Date;
}): ForumReply {
  return {
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    body: row.body,
    status: row.status,
    reportCount: row.report_count,
    createdAt: row.created_at,
  };
}

export async function listPublishedReplies(postId: string, limit = 200): Promise<ForumReply[]> {
  const result = await getForumPool().query(
    `SELECT id, post_id, author_id, body, status, report_count, created_at
     FROM forum.replies WHERE post_id = $1 AND status = 'PUBLISHED'
     ORDER BY created_at ASC LIMIT $2`,
    [postId, limit],
  );
  return result.rows.map(rowToReply);
}

export interface CreateReplyParams {
  profileId: string;
  postId: string;
  body: string;
  filterConfig: FilterConfig;
  stockDirectory: StockDirectory;
}

export async function createReply(params: CreateReplyParams): Promise<ForumReply> {
  await assertMinimumIntervalElapsed(params.profileId);
  await assertUnderDailyReplyLimit(params.profileId);
  await assertNoDuplicateReply(params.profileId, params.body);

  const verdict = runForumFilter(params.body, params.filterConfig, params.stockDirectory);
  if (verdict.action === "BLOCK") {
    await recordBlockedAttempt({
      profileId: params.profileId,
      channelId: null,
      matchedCategory: verdict.reasons[0]!.category === "fraud_redirect" ? "FRAUD_REDIRECT"
        : verdict.reasons[0]!.category === "stock_trading_advice" ? "STOCK_ADVICE" : "PROFANITY",
      matchedTermRef: verdict.reasons[0]!.matched,
      rawContent: params.body,
    });
    throw new ContentBlockedError(verdict.reasons.map((r) => r.message));
  }
  if (verdict.action === "NOTIFY") {
    notifyAdmin("Reply passed with a NOTIFY-level filter hit", { profileId: params.profileId, reasons: verdict.reasons });
  }

  const result = await getForumPool().query(
    `INSERT INTO forum.replies (post_id, author_id, body, status)
     VALUES ($1, $2, $3, 'PUBLISHED')
     RETURNING id, post_id, author_id, body, status, report_count, created_at`,
    [params.postId, params.profileId, params.body],
  );
  return rowToReply(result.rows[0]!);
}

export async function editReply(
  replyId: string,
  authorId: string,
  body: string,
  filterConfig: FilterConfig,
  stockDirectory: StockDirectory,
): Promise<ForumReply> {
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
    notifyAdmin("Reply edit passed with a NOTIFY-level filter hit", { replyId, reasons: verdict.reasons });
  }

  const result = await getForumPool().query(
    `UPDATE forum.replies SET body = $3, updated_at = now()
     WHERE id = $1 AND author_id = $2 AND status != 'DELETED'
     RETURNING id, post_id, author_id, body, status, report_count, created_at`,
    [replyId, authorId, body],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Reply not found or not owned by this author.");
  return rowToReply(row);
}

export async function deleteOwnReply(replyId: string, authorId: string): Promise<void> {
  await getForumPool().query(
    `UPDATE forum.replies SET body = NULL, status = 'DELETED', deleted_at = now(), updated_at = now()
     WHERE id = $1 AND author_id = $2`,
    [replyId, authorId],
  );
}
