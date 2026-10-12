// Notification channel for anomalies: Telegram Bot API, per the user's decision (TELEGRAM_BOT_TOKEN +
// TELEGRAM_CHAT_ID). Before those env vars are set, this silently no-ops and reports that in its
// return value -- the daily report still runs and logs to production_scheduler_runs every day either
// way (never blocked on this), it just can't reach anyone yet. Once the token/chat id are set, a
// genuine Telegram message is sent via https://api.telegram.org/bot<token>/sendMessage.
export type NotifyResult = { attempted: boolean; channel: "TELEGRAM" | "NONE"; ok?: boolean; reason?: string; httpStatus?: number };

export async function notifyAnomaly(summary: string): Promise<NotifyResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { attempted: false, channel: "NONE", reason: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set yet" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: summary }),
      signal: AbortSignal.timeout(10_000),
    });
    return { attempted: true, channel: "TELEGRAM", ok: res.ok, httpStatus: res.status };
  } catch (e) {
    return { attempted: true, channel: "TELEGRAM", ok: false, reason: String(e) };
  }
}
