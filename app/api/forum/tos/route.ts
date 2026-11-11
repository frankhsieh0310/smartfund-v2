import { prisma } from "@/lib/prisma";
import { getAccountForRequest } from "@/lib/auth/userService";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
const ok = (data: unknown, status = 200) => Response.json({ data, error: null }, { status, headers: { "Cache-Control": "no-store", ...corsHeaders } });
const fail = (message: string, status = 400) => Response.json({ data: null, error: { message } }, { status, headers: corsHeaders });

// 2026-11-11（使用者核准）: 版本字串寫在這裡一處，跟手機App顯示的條款文字版本要對應——改了條款
// 內容就改這個版本號，舊的同意紀錄不會自動算數，使用者要重新同意一次。
export const FORUM_TOS_VERSION = "2026-11-11-v1";

export async function GET(request: Request) {
  try {
    const account = await getAccountForRequest(request);
    if (!account) return fail("Authentication required.", 401);
    const rows = await prisma.$queryRawUnsafe<Array<{ tos_version: string; accepted_at: Date }>>(
      `SELECT tos_version, accepted_at FROM forum_tos_acceptances WHERE user_id = $1`,
      account.id,
    );
    const accepted = rows.length > 0 && rows[0].tos_version === FORUM_TOS_VERSION;
    return ok({ accepted, currentVersion: FORUM_TOS_VERSION, acceptedVersion: rows[0]?.tos_version ?? null });
  } catch {
    return fail("Unable to load TOS status.", 500);
  }
}

export async function POST(request: Request) {
  try {
    const account = await getAccountForRequest(request);
    if (!account) return fail("Authentication required.", 401);
    await prisma.$executeRawUnsafe(
      `INSERT INTO forum_tos_acceptances (user_id, tos_version, accepted_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET tos_version = $2, accepted_at = now()`,
      account.id, FORUM_TOS_VERSION,
    );
    return ok({ accepted: true });
  } catch {
    return fail("Unable to record TOS acceptance.", 500);
  }
}
