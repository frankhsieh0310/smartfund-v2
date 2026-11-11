import { prisma } from "@/lib/prisma";
import { getAccountForRequest } from "@/lib/auth/userService";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
const ok = (data: unknown, status = 200) => Response.json({ data, error: null }, { status, headers: { "Cache-Control": "no-store", ...corsHeaders } });
const fail = (message: string, status = 400) => Response.json({ data: null, error: { message } }, { status, headers: corsHeaders });

export async function POST(request: Request) {
  try {
    const account = await getAccountForRequest(request);
    if (!account) return fail("Authentication required.", 401);
    const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const targetType = input.targetType === "POST" || input.targetType === "REPLY" ? input.targetType : null;
    const targetId = typeof input.targetId === "string" ? input.targetId : null;
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
    if (!targetType || !targetId || !reason) return fail("targetType, targetId and reason are required.");

    const table = targetType === "POST" ? "forum_posts" : "forum_replies";
    const exists = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${table} WHERE id = $1::uuid AND deleted_at IS NULL`, targetId);
    if (!exists.length) return fail("Target not found.", 404);

    await prisma.$executeRawUnsafe(
      `INSERT INTO forum_reports (target_type, target_id, reporter_user_id, reason) VALUES ($1, $2::uuid, $3, $4)`,
      targetType, targetId, account.id, reason,
    );
    return ok({ reported: true }, 201);
  } catch {
    return fail("Unable to submit report.", 500);
  }
}
