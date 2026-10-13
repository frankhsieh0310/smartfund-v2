import { getForumPool } from "../pgPool.ts";
import type { PoolClient } from "pg";
import { sendTelegramMessage } from "../telegram/client.ts";

/**
 * Sends a NOTIFY-level filter hit (or other admin-attention event) to the Telegram admin bot's chat.
 * Always logs server-side too, so nothing is lost if FORUM_ADMIN_CHAT_ID/FORUM_ADMIN_BOT_TOKEN aren't
 * configured yet or the Telegram API call fails — this must never throw and block the caller's own
 * request (a post/reply that passed the filter with a NOTIFY verdict should still succeed).
 */
export function notifyAdmin(reason: string, context: Record<string, unknown>): void {
  console.warn(`[forum:notifyAdmin] ${reason}`, context);

  const chatId = process.env.FORUM_ADMIN_CHAT_ID;
  if (!chatId) return;

  const text = `⚠️ ${reason}\n${JSON.stringify(context, null, 2)}`;
  sendTelegramMessage(chatId, text).catch((e) => {
    console.error("[forum:notifyAdmin] failed to send Telegram notification", e);
  });
}

export type ModerationActionType =
  | "HIDE"
  | "DELETE"
  | "SUSPEND_1D"
  | "SUSPEND_7D"
  | "SUSPEND_30D"
  | "BAN"
  | "APPROVE";
export type ModerationTargetType = "POST" | "REPLY" | "PROFILE";

export async function logModerationAction(
  executor: PoolClient | ReturnType<typeof getForumPool>,
  params: {
    actionType: ModerationActionType;
    targetType: ModerationTargetType;
    targetRef: string;
    actorRef: string;
    reportCountAtAction?: number;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO forum.moderation_log (action_type, target_type, target_ref, actor_ref, report_count_at_action)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.actionType, params.targetType, params.targetRef, params.actorRef, params.reportCountAtAction ?? null],
  );
}

export async function recordBlockedAttempt(params: {
  profileId: string;
  channelId: string | null;
  matchedCategory: "FRAUD_REDIRECT" | "STOCK_ADVICE" | "PROFANITY";
  matchedTermRef: string | null;
  rawContent: string;
}): Promise<void> {
  await getForumPool().query(
    `INSERT INTO forum.blocked_attempts (profile_id, channel_id, matched_category, matched_term_ref, raw_content)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.profileId, params.channelId, params.matchedCategory, params.matchedTermRef, params.rawContent],
  );
}

/** Same-user repeat-blocked-attempt threshold from the filter config's `thresholds` section. */
export async function countRecentBlockedAttempts(profileId: string, windowMinutes: number): Promise<number> {
  const result = await getForumPool().query<{ count: string }>(
    `SELECT count(*) FROM forum.blocked_attempts
     WHERE profile_id = $1 AND attempted_at > now() - ($2 || ' minutes')::interval`,
    [profileId, windowMinutes],
  );
  return Number(result.rows[0]?.count ?? 0);
}
