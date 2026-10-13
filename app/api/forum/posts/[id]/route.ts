import { requireForumAccess } from "@/lib/forum/requestContext";
import { getPostById, editPost, deleteOwnPost } from "@/lib/forum/data/posts";
import { loadFilterConfig, loadStockDirectory } from "@/lib/forum/data/filterConfig";
import { ok, fail, handleForumError, readJsonBody } from "@/lib/forum/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireForumAccess(request);
    const { id } = await params;
    const post = await getPostById(id);
    if (!post || post.status === "DELETED" || (post.status !== "PUBLISHED" && post.status !== "PENDING")) {
      return fail("找不到這篇文章。", 404);
    }
    return ok(post);
  } catch (e) {
    return handleForumError(e);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { profileId } = await requireForumAccess(request);
    const { id } = await params;
    const body = await readJsonBody(request);
    const newBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!newBody) return fail("body 為必填。");

    const post = await editPost(id, profileId, newBody, loadFilterConfig(), loadStockDirectory());
    return ok(post);
  } catch (e) {
    return handleForumError(e);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { profileId } = await requireForumAccess(request);
    const { id } = await params;
    await deleteOwnPost(id, profileId);
    return ok({ deleted: true });
  } catch (e) {
    return handleForumError(e);
  }
}
