// Telegram webhook receiver for the forum admin bot (separate bot from @smartmatch_monitor_bot per
// the week-1 decision). Set up via Telegram's setWebhook API — see the report for the exact steps;
// this route only validates and dispatches, it never calls setWebhook itself.

import { isAuthorizedTelegramWebhook, isWhitelistedChat } from "@/lib/forum/telegram/auth";
import { parseCommand } from "@/lib/forum/telegram/commands";
import { dispatchCommand, executeConfirmedAction } from "@/lib/forum/telegram/handlers";
import { decodePendingAction, CANCEL_CALLBACK_DATA } from "@/lib/forum/telegram/pendingActions";
import { sendTelegramMessage, answerTelegramCallbackQuery } from "@/lib/forum/telegram/client";
import type { TelegramUpdate } from "@/lib/forum/telegram/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorized = isAuthorizedTelegramWebhook(
    request.headers.get("x-telegram-bot-api-secret-token"),
    process.env.TELEGRAM_WEBHOOK_SECRET,
  );
  if (!authorized) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (!isWhitelistedChat(chatId, process.env.FORUM_ADMIN_CHAT_ID)) {
    // Acknowledge with 200 so Telegram doesn't retry, but take no action and reveal nothing.
    return Response.json({ ok: true, ignored: true });
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query.id, update.callback_query.data ?? "", chatId!);
    return Response.json({ ok: true });
  }

  if (update.message?.text) {
    const reply = await dispatchCommand(parseCommand(update.message.text));
    await sendTelegramMessage(chatId!, reply.text, reply.inlineKeyboard);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: true });
}

async function handleCallbackQuery(callbackQueryId: string, data: string, chatId: number): Promise<void> {
  if (data === CANCEL_CALLBACK_DATA) {
    await answerTelegramCallbackQuery(callbackQueryId, "已取消");
    await sendTelegramMessage(chatId, "已取消，沒有執行任何動作。");
    return;
  }

  const action = decodePendingAction(data);
  if (!action) {
    await answerTelegramCallbackQuery(callbackQueryId, "這個確認按鈕已失效");
    return;
  }

  const reply = await executeConfirmedAction(action);
  await answerTelegramCallbackQuery(callbackQueryId, "已執行");
  await sendTelegramMessage(chatId, reply.text);
}
