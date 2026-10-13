// Reminds the admin (via Telegram) about reports that have sat unresolved past 20 hours — per the
// week-1 decision ("超過 20 小時未處理再提醒一次"). Deliberately NOT added to vercel.json yet (the
// user asked to review the proposed schedule first — see docs/specs/launch-plan-30days.md's update).
//
// Suggested vercel.json entry once approved:
//   { "path": "/api/cron/forum-overdue-reports", "schedule": "0 * * * *" }   // hourly
// Hourly is enough slack against a 20h/24h SLA without needing per-minute precision, and matches this
// project's existing cron cadence conventions (most of vercel.json's crons run on an hourly-or-coarser
// schedule already).

import { getForumPool } from "@/lib/forum/pgPool";
import { sendTelegramMessage } from "@/lib/forum/telegram/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const chatId = process.env.FORUM_ADMIN_CHAT_ID;
  if (!chatId) {
    return Response.json({ skipped: true, reason: "FORUM_ADMIN_CHAT_ID not configured" });
  }

  const result = await getForumPool().query<{ id: string; target_type: string; target_id: string; created_at: Date }>(
    `SELECT id, target_type, target_id, created_at FROM forum.reports
     WHERE resolved_at IS NULL AND created_at < now() - interval '20 hours'
     ORDER BY created_at ASC`,
  );

  if (result.rows.length === 0) {
    return Response.json({ overdue: 0 });
  }

  const lines = result.rows.map(
    (r) => `#${r.id.slice(0, 8)} ${r.target_type} ${r.target_id.slice(0, 8)}（已等待超過 20 小時）`,
  );
  await sendTelegramMessage(chatId, `⏰ 有 ${result.rows.length} 筆檢舉超過 20 小時未處理：\n${lines.join("\n")}`);

  return Response.json({ overdue: result.rows.length });
}
