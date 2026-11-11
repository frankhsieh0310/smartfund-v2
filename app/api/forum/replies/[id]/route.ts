import { prisma } from "@/lib/prisma";
import { getAccountForRequest } from "@/lib/auth/userService";
import { isForumAdmin } from "@/lib/forum/admin";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
const ok = (data: unknown, status = 200) => Response.json({ data, error: null }, { status, headers: { "Cache-Control": "no-store", ...corsHeaders } });
const fail = (message: string, status = 400) => Response.json({ data: null, error: { message } }, { status, headers: corsHeaders });

export async function DELETE(request: Request, context: RouteContext<"/api/forum/replies/[id]">) {
  try {
    const { id } = await context.params;
    const account = await getAccountForRequest(request);
    if (!account) return fail("Authentication required.", 401);
    if (!(await isForumAdmin(account.id))) return fail("Forbidden.", 403);
    await prisma.$executeRawUnsafe(`UPDATE forum_replies SET deleted_at = now(), deleted_by_admin = true WHERE id = $1::uuid AND deleted_at IS NULL`, id);
    return ok({ deleted: true });
  } catch {
    return fail("Unable to delete reply.", 500);
  }
}
