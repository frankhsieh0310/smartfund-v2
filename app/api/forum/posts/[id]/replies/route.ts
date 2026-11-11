import { prisma } from "@/lib/prisma";
import { getAccountForRequest } from "@/lib/auth/userService";
import { assertNoProfanity } from "@/lib/forum/profanityFilter";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
const ok = (data: unknown, status = 200) => Response.json({ data, error: null }, { status, headers: { "Cache-Control": "no-store", ...corsHeaders } });
const fail = (message: string, status = 400) => Response.json({ data: null, error: { message } }, { status, headers: corsHeaders });

export async function POST(request: Request, context: RouteContext<"/api/forum/posts/[id]/replies">) {
  try {
    const { id } = await context.params;
    const account = await getAccountForRequest(request);
    if (!account) return fail("Authentication required.", 401);

    const tosRows = await prisma.$queryRawUnsafe<Array<{ user_id: string }>>(`SELECT user_id FROM forum_tos_acceptances WHERE user_id = $1`, account.id);
    if (tosRows.length === 0) return fail("TOS_NOT_ACCEPTED", 403);

    const posts = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM forum_posts WHERE id = $1::uuid AND deleted_at IS NULL`, id);
    if (!posts.length) return fail("Post not found.", 404);

    const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const body = typeof input.body === "string" ? input.body.trim().slice(0, 3000) : "";
    if (!body) return fail("Body is required.");
    try { assertNoProfanity(body); } catch { return fail("CONTAINS_BLOCKED_WORDS", 422); }

    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.$queryRawUnsafe<Array<{ id: string; created_at: Date }>>(
        `INSERT INTO forum_replies (post_id, author_user_id, body) VALUES ($1::uuid, $2, $3) RETURNING id, created_at`,
        id, account.id, body,
      );
      await tx.$executeRawUnsafe(`UPDATE forum_posts SET reply_count = reply_count + 1 WHERE id = $1::uuid`, id);
      return row[0];
    });
    return ok({ id: result.id, createdAt: result.created_at.toISOString() }, 201);
  } catch {
    return fail("Unable to create reply.", 500);
  }
}
