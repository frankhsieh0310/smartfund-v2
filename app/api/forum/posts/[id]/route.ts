import { prisma } from "@/lib/prisma";
import { getAccountForRequest } from "@/lib/auth/userService";
import { isForumAdmin } from "@/lib/forum/admin";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
const ok = (data: unknown, status = 200) => Response.json({ data, error: null }, { status, headers: { "Cache-Control": "no-store", ...corsHeaders } });
const fail = (message: string, status = 400) => Response.json({ data: null, error: { message } }, { status, headers: corsHeaders });

export async function GET(request: Request, context: RouteContext<"/api/forum/posts/[id]">) {
  try {
    const { id } = await context.params;
    const posts = await prisma.$queryRawUnsafe<Array<{
      id: string; author_user_id: string; author_name: string | null; title: string; body: string; created_at: Date;
    }>>(
      `SELECT p.id, p.author_user_id, u.display_name AS author_name, p.title, p.body, p.created_at
         FROM forum_posts p JOIN public.users u ON u.id = p.author_user_id
        WHERE p.id = $1::uuid AND p.deleted_at IS NULL`,
      id,
    );
    if (!posts.length) return fail("Post not found.", 404);
    const replies = await prisma.$queryRawUnsafe<Array<{
      id: string; author_user_id: string; author_name: string | null; body: string; created_at: Date;
    }>>(
      `SELECT r.id, r.author_user_id, u.display_name AS author_name, r.body, r.created_at
         FROM forum_replies r JOIN public.users u ON u.id = r.author_user_id
        WHERE r.post_id = $1::uuid AND r.deleted_at IS NULL
        ORDER BY r.created_at ASC`,
      id,
    );
    const p = posts[0];
    return ok({
      post: { id: p.id, authorUserId: p.author_user_id, authorName: p.author_name ?? "會員", title: p.title, body: p.body, createdAt: p.created_at.toISOString() },
      replies: replies.map((r) => ({ id: r.id, authorUserId: r.author_user_id, authorName: r.author_name ?? "會員", body: r.body, createdAt: r.created_at.toISOString() })),
      disclaimer: "會員個人意見，非投資建議",
    });
  } catch {
    return fail("Unable to load post.", 500);
  }
}

// 管理員刪文（2026-11-11 使用者核准）: 軟刪除（deleted_at），不是硬刪——保留原始內容供日後審核
// 爭議，只是不再顯示給一般使用者。
export async function DELETE(request: Request, context: RouteContext<"/api/forum/posts/[id]">) {
  try {
    const { id } = await context.params;
    const account = await getAccountForRequest(request);
    if (!account) return fail("Authentication required.", 401);
    if (!(await isForumAdmin(account.id))) return fail("Forbidden.", 403);
    await prisma.$executeRawUnsafe(`UPDATE forum_posts SET deleted_at = now(), deleted_by_admin = true WHERE id = $1::uuid AND deleted_at IS NULL`, id);
    return ok({ deleted: true });
  } catch {
    return fail("Unable to delete post.", 500);
  }
}
