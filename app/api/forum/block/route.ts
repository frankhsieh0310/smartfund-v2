import { prisma } from "@/lib/prisma";
import { getAccountForRequest } from "@/lib/auth/userService";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
const ok = (data: unknown, status = 200) => Response.json({ data, error: null }, { status, headers: { "Cache-Control": "no-store", ...corsHeaders } });
const fail = (message: string, status = 400) => Response.json({ data: null, error: { message } }, { status, headers: corsHeaders });

export async function GET(request: Request) {
  try {
    const account = await getAccountForRequest(request);
    if (!account) return fail("Authentication required.", 401);
    const rows = await prisma.$queryRawUnsafe<Array<{ blocked_user_id: string; display_name: string | null; created_at: Date }>>(
      `SELECT b.blocked_user_id, u.display_name, b.created_at
         FROM forum_blocks b JOIN public.users u ON u.id = b.blocked_user_id
        WHERE b.blocker_user_id = $1 ORDER BY b.created_at DESC`,
      account.id,
    );
    return ok({ blocked: rows.map((r) => ({ userId: r.blocked_user_id, name: r.display_name ?? "會員", blockedAt: r.created_at.toISOString() })) });
  } catch {
    return fail("Unable to load blocked users.", 500);
  }
}

export async function POST(request: Request) {
  try {
    const account = await getAccountForRequest(request);
    if (!account) return fail("Authentication required.", 401);
    const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const blockedUserId = typeof input.userId === "string" ? input.userId : null;
    if (!blockedUserId) return fail("userId is required.");
    if (blockedUserId === account.id) return fail("Cannot block yourself.");
    await prisma.$executeRawUnsafe(
      `INSERT INTO forum_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      account.id, blockedUserId,
    );
    return ok({ blocked: true }, 201);
  } catch {
    return fail("Unable to block user.", 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const account = await getAccountForRequest(request);
    if (!account) return fail("Authentication required.", 401);
    const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const blockedUserId = typeof input.userId === "string" ? input.userId : null;
    if (!blockedUserId) return fail("userId is required.");
    await prisma.$executeRawUnsafe(`DELETE FROM forum_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2`, account.id, blockedUserId);
    return ok({ unblocked: true });
  } catch {
    return fail("Unable to unblock user.", 500);
  }
}
