// Executes each parsed admin command against the forum data layer, and writes an append-only
// forum.moderation_log row for every action taken (actor_ref = 'TELEGRAM_ADMIN' — there is only one
// whitelisted admin chat, so a more specific actor isn't meaningful here).

import { getForumPool } from "../pgPool.ts";
import { logModerationAction } from "../data/moderation.ts";
import { HELP_TEXT, type ParsedCommand } from "./commands.ts";
import { encodePendingAction, type PendingAction } from "./pendingActions.ts";
import { CANCEL_CALLBACK_DATA } from "./pendingActions.ts";
import type { InlineKeyboardButton } from "./types.ts";

const ACTOR_REF = "TELEGRAM_ADMIN";

export interface CommandReply {
  text: string;
  inlineKeyboard?: InlineKeyboardButton[][];
}

export async function listPendingReports(): Promise<CommandReply> {
  const result = await getForumPool().query<{
    id: string;
    target_type: string;
    target_id: string;
    reason: string;
    created_at: Date;
  }>(
    `SELECT id, target_type, target_id, reason, created_at FROM forum.reports
     WHERE resolved_at IS NULL ORDER BY created_at ASC LIMIT 20`,
  );
  if (result.rows.length === 0) return { text: "目前沒有待處理的檢舉。" };

  const lines = result.rows.map(
    (r) => `#${r.id.slice(0, 8)} ${r.target_type} ${r.target_id.slice(0, 8)} — ${r.reason}（${r.created_at.toISOString()}）`,
  );
  return { text: `待處理檢舉（${result.rows.length} 筆）：\n${lines.join("\n")}` };
}

export async function listPendingPosts(): Promise<CommandReply> {
  const result = await getForumPool().query<{ id: string; title: string | null; created_at: Date }>(
    `SELECT id, title, created_at FROM forum.posts WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 20`,
  );
  if (result.rows.length === 0) return { text: "目前沒有待審核的首篇文章。" };

  const lines = result.rows.map((r) => `#${r.id.slice(0, 8)} 《${r.title ?? "(無標題)"}》（${r.created_at.toISOString()}）`);
  return { text: `待審核首篇文章（${result.rows.length} 篇）：\n${lines.join("\n")}` };
}

export async function approvePost(postId: string): Promise<CommandReply> {
  const result = await getForumPool().query(
    `UPDATE forum.posts SET status = 'PUBLISHED', updated_at = now() WHERE id = $1 AND status = 'PENDING'`,
    [postId],
  );
  if ((result.rowCount ?? 0) === 0) return { text: "找不到這篇待審文章，或它已經處理過了。" };

  await logModerationAction(getForumPool(), { actionType: "APPROVE", targetType: "POST", targetRef: postId, actorRef: ACTOR_REF });
  return { text: `已核准文章 ${postId}。` };
}

export async function rejectPost(postId: string): Promise<CommandReply> {
  const result = await getForumPool().query(
    `UPDATE forum.posts SET title = NULL, body = NULL, status = 'DELETED', deleted_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'PENDING'`,
    [postId],
  );
  if ((result.rowCount ?? 0) === 0) return { text: "找不到這篇待審文章，或它已經處理過了。" };

  await logModerationAction(getForumPool(), { actionType: "DELETE", targetType: "POST", targetRef: postId, actorRef: ACTOR_REF });
  return { text: `已退回（刪除）文章 ${postId}。` };
}

/** Hide executes immediately (no confirm button) — reversible by re-publishing manually if needed. */
export async function hideContent(targetType: "POST" | "REPLY", targetId: string): Promise<CommandReply> {
  const table = targetType === "POST" ? "forum.posts" : "forum.replies";
  const result = await getForumPool().query(
    `UPDATE ${table} SET status = 'HIDDEN', updated_at = now() WHERE id = $1 AND status NOT IN ('HIDDEN', 'DELETED')`,
    [targetId],
  );
  if ((result.rowCount ?? 0) === 0) return { text: "找不到這則內容，或它已經被隱藏／刪除了。" };

  await logModerationAction(getForumPool(), { actionType: "HIDE", targetType, targetRef: targetId, actorRef: ACTOR_REF });
  return { text: `已隱藏 ${targetType} ${targetId}。` };
}

function confirmKeyboard(action: PendingAction): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ 確認執行", callback_data: encodePendingAction(action) },
      { text: "❌ 取消", callback_data: CANCEL_CALLBACK_DATA },
    ],
  ];
}

export function buildDeleteConfirmation(targetType: "POST" | "REPLY", targetId: string): CommandReply {
  return {
    text: `確定要刪除 ${targetType} ${targetId} 嗎？這會清空內容，無法復原。`,
    inlineKeyboard: confirmKeyboard({ kind: "delete", targetType, targetId }),
  };
}

export function buildSuspendConfirmation(profileId: string, duration: "1D" | "7D" | "30D"): CommandReply {
  const label = { "1D": "1 天", "7D": "7 天", "30D": "30 天" }[duration];
  return {
    text: `確定要將使用者 ${profileId} 停權 ${label} 嗎？`,
    inlineKeyboard: confirmKeyboard({ kind: "suspend", profileId, duration }),
  };
}

export function buildBanConfirmation(profileId: string): CommandReply {
  return {
    text: `確定要永久停權使用者 ${profileId} 嗎？這個動作需要你自己之後手動解除。`,
    inlineKeyboard: confirmKeyboard({ kind: "ban", profileId }),
  };
}

export async function executeConfirmedAction(action: PendingAction): Promise<CommandReply> {
  switch (action.kind) {
    case "delete": {
      const table = action.targetType === "POST" ? "forum.posts" : "forum.replies";
      const clearCols = action.targetType === "POST" ? "title = NULL, body = NULL" : "body = NULL";
      const result = await getForumPool().query(
        `UPDATE ${table} SET ${clearCols}, status = 'DELETED', deleted_at = now(), updated_at = now() WHERE id = $1`,
        [action.targetId],
      );
      if ((result.rowCount ?? 0) === 0) return { text: "找不到這則內容。" };
      await logModerationAction(getForumPool(), {
        actionType: "DELETE",
        targetType: action.targetType,
        targetRef: action.targetId,
        actorRef: ACTOR_REF,
      });
      return { text: `已刪除 ${action.targetType} ${action.targetId}。` };
    }
    case "suspend": {
      const hours = { "1D": 24, "7D": 24 * 7, "30D": 24 * 30 }[action.duration];
      await getForumPool().query(
        `INSERT INTO forum.suspensions (profile_id, type, reason, ends_at, created_by)
         VALUES ($1, $2, 'Telegram 管理員停權', now() + ($3 || ' hours')::interval, $4)`,
        [action.profileId, `TEMP_${action.duration}`, hours, ACTOR_REF],
      );
      await getForumPool().query(`UPDATE forum.profiles SET status = 'SUSPENDED', updated_at = now() WHERE id = $1`, [
        action.profileId,
      ]);
      const actionType = { "1D": "SUSPEND_1D", "7D": "SUSPEND_7D", "30D": "SUSPEND_30D" }[action.duration] as
        | "SUSPEND_1D"
        | "SUSPEND_7D"
        | "SUSPEND_30D";
      await logModerationAction(getForumPool(), {
        actionType,
        targetType: "PROFILE",
        targetRef: action.profileId,
        actorRef: ACTOR_REF,
      });
      return { text: `已停權使用者 ${action.profileId}（${action.duration}）。` };
    }
    case "ban": {
      await getForumPool().query(
        `INSERT INTO forum.suspensions (profile_id, type, reason, ends_at, created_by)
         VALUES ($1, 'PERMANENT', '永久停權', NULL, $2)`,
        [action.profileId, ACTOR_REF],
      );
      await getForumPool().query(`UPDATE forum.profiles SET status = 'BANNED', updated_at = now() WHERE id = $1`, [
        action.profileId,
      ]);
      await logModerationAction(getForumPool(), {
        actionType: "BAN",
        targetType: "PROFILE",
        targetRef: action.profileId,
        actorRef: ACTOR_REF,
      });
      return { text: `已永久停權使用者 ${action.profileId}。` };
    }
  }
}

export function dispatchCommand(command: ParsedCommand): Promise<CommandReply> | CommandReply {
  switch (command.kind) {
    case "reports":
      return listPendingReports();
    case "pending":
      return listPendingPosts();
    case "approve":
      return approvePost(command.postId);
    case "reject":
      return rejectPost(command.postId);
    case "hide":
      return hideContent(command.targetType, command.targetId);
    case "delete_request":
      return buildDeleteConfirmation(command.targetType, command.targetId);
    case "suspend_request":
      return buildSuspendConfirmation(command.profileId, command.duration);
    case "ban_request":
      return buildBanConfirmation(command.profileId);
    case "help":
      return { text: HELP_TEXT };
    case "unknown":
      return { text: `看不懂這個指令：${command.raw}\n\n${HELP_TEXT}` };
  }
}
