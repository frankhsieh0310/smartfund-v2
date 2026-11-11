// 會員討論區 — 發文清單／發文（2026-11-11 使用者核准）。無私訊；每則發文固定附加「會員個人意見，
// 非投資建議」標示（前端畫面上顯示，這裡後端只負責存title/body本身，disclaimer是靜態文字，不是
// 使用者輸入，不用存進DB）。寫入前先過不當字詞過濾，命中直接拒絕（擋在發布前，不是事後下架）。
import { prisma } from "@/lib/prisma";
import { getAccountForRequest } from "@/lib/auth/userService";
import { assertNoProfanity } from "@/lib/forum/profanityFilter";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
const ok = (data: unknown, status = 200) => Response.json({ data, error: null }, { status, headers: { "Cache-Control": "no-store", ...corsHeaders } });
const fail = (message: string, status = 400) => Response.json({ data: null, error: { message } }, { status, headers: corsHeaders });

async function account(request: Request) {
  const value = await getAccountForRequest(request);
  if (!value) throw new Error("AUTH");
  return value;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    // 2026-11-11（封鎖功能，使用者核准）: 封鎖是「我不想看到這個人的內容」，不是全站移除——用
    // 當前使用者（若登入）的封鎖清單過濾列表，未登入時不過濾（看得到全部公開發文）。
    let blockedIds: string[] = [];
    try {
      const acc = await getAccountForRequest(request);
      if (acc) {
        const rows = await prisma.$queryRawUnsafe<Array<{ blocked_user_id: string }>>(
          `SELECT blocked_user_id FROM forum_blocks WHERE blocker_user_id = $1`,
          acc.id,
        );
        blockedIds = rows.map((r) => r.blocked_user_id);
      }
    } catch { /* 未登入時不過濾，不是錯誤 */ }

    const posts = await prisma.$queryRawUnsafe<Array<{
      id: string; author_user_id: string; author_name: string | null; title: string; body: string;
      created_at: Date; reply_count: number;
    }>>(
      `SELECT p.id, p.author_user_id, u.display_name AS author_name, p.title, p.body, p.created_at, p.reply_count
         FROM forum_posts p JOIN public.users u ON u.id = p.author_user_id
        WHERE p.deleted_at IS NULL ${blockedIds.length ? "AND p.author_user_id <> ALL($2::text[])" : ""}
        ORDER BY p.created_at DESC
        LIMIT $1 OFFSET ${offset}`,
      ...(blockedIds.length ? [limit, blockedIds] : [limit]),
    );
    return ok({
      posts: posts.map((p) => ({
        id: p.id, authorUserId: p.author_user_id, authorName: p.author_name ?? "會員",
        title: p.title, body: p.body, createdAt: p.created_at.toISOString(), replyCount: p.reply_count,
      })),
      page,
      disclaimer: "會員個人意見，非投資建議",
    });
  } catch (e) {
    return fail("Unable to load posts.", 500);
  }
}

export async function POST(request: Request) {
  try {
    const user = await account(request);
    const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const title = typeof input.title === "string" ? input.title.trim().slice(0, 100) : "";
    const body = typeof input.body === "string" ? input.body.trim().slice(0, 5000) : "";
    if (!title || !body) return fail("Title and body are required.");

    // 2026-11-11（使用條款同意，使用者核准）: 發文前必須先同意過討論區使用條款，沒同意過一律
    // 擋下，不讓畫面繞過同意流程直接呼叫這支API發文。
    const tosRows = await prisma.$queryRawUnsafe<Array<{ user_id: string }>>(
      `SELECT user_id FROM forum_tos_acceptances WHERE user_id = $1`,
      user.id,
    );
    if (tosRows.length === 0) return fail("TOS_NOT_ACCEPTED", 403);

    try {
      assertNoProfanity(title);
      assertNoProfanity(body);
    } catch {
      return fail("CONTAINS_BLOCKED_WORDS", 422);
    }

    const row = await prisma.$queryRawUnsafe<Array<{ id: string; created_at: Date }>>(
      `INSERT INTO forum_posts (author_user_id, title, body) VALUES ($1, $2, $3) RETURNING id, created_at`,
      user.id, title, body,
    );
    return ok({ id: row[0].id, createdAt: row[0].created_at.toISOString() }, 201);
  } catch (e) {
    return fail(e instanceof Error && e.message === "AUTH" ? "Authentication required." : "Unable to create post.", e instanceof Error && e.message === "AUTH" ? 401 : 500);
  }
}
