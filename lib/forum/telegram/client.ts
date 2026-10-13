// Thin Telegram Bot API client. Reads FORUM_ADMIN_BOT_TOKEN from the environment only — the token
// itself is never logged, returned in a response, or written anywhere.

import type { InlineKeyboardButton } from "./types";

function apiBase(): string {
  const token = process.env.FORUM_ADMIN_BOT_TOKEN;
  if (!token) throw new Error("FORUM_ADMIN_BOT_TOKEN is not configured");
  return `https://api.telegram.org/bot${token}`;
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  inlineKeyboard?: InlineKeyboardButton[][],
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard };

  const response = await fetch(`${apiBase()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.error("[telegram] sendMessage failed", response.status, await response.text().catch(() => ""));
  }
}

export async function answerTelegramCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const response = await fetch(`${apiBase()}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
  if (!response.ok) {
    console.error("[telegram] answerCallbackQuery failed", response.status, await response.text().catch(() => ""));
  }
}
