import { requireForumAccess } from "@/lib/forum/requestContext";
import { listPublishedReplies, createReply } from "@/lib/forum/data/replies";
import { getPostById } from "@/lib/forum/data/posts";
import { loadFilterConfig, loadStockDirectory } from "@/lib/forum/data/filterConfig";
import { ok, fail, handleForumError, readJsonBody } from "@/lib/forum/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireForumAccess(request);
    const { id } = await params;
    return ok(await listPublishedReplies(id));
  } catch (e) {
    return handleForumError(e);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { profileId } = await requireForumAccess(request);
    const { id } = await params;

    const post = await getPostById(id);
    if (!post || post.status !== "PUBLISHED") return fail("這篇文章目前無法回覆。", 404);

    const body = await readJsonBody(request);
    const replyBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!replyBody) return fail("body 為必填。");

    const reply = await createReply({
      profileId,
      postId: id,
      body: replyBody,
      filterConfig: loadFilterConfig(),
      stockDirectory: loadStockDirectory(),
    });
    return ok(reply, 201);
  } catch (e) {
    return handleForumError(e);
  }
}
