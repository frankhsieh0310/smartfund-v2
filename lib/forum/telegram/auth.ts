// Telegram webhook authentication: two independent checks, both must pass.
//  1. The `X-Telegram-Bot-Api-Secret-Token` header must match the secret configured when calling
//     Telegram's setWebhook (https://core.telegram.org/bots/api#setwebhook) — proves the request
//     actually came from Telegram's servers, not an arbitrary POST to this URL.
//  2. The message/callback's chat id must match the single whitelisted admin chat id
//     (FORUM_ADMIN_CHAT_ID) — proves it's the user's own chat, not some other chat the bot is in.
// Both env vars are configured by the user directly in Vercel; this code only reads them, never logs
// or returns their values.

import { timingSafeEqual } from "node:crypto";

export function isAuthorizedTelegramWebhook(
  secretTokenHeader: string | null,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret) return false;
  if (!secretTokenHeader) return false;

  const received = Buffer.from(secretTokenHeader, "utf-8");
  const expected = Buffer.from(expectedSecret, "utf-8");
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}

export function isWhitelistedChat(chatId: number | undefined, expectedChatId: string | undefined): boolean {
  if (chatId === undefined) return false;
  if (!expectedChatId) return false;
  return String(chatId) === expectedChatId.trim();
}
