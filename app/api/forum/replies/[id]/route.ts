import { requireForumAccess } from "@/lib/forum/requestContext";
import { editReply, deleteOwnReply } from "@/lib/forum/data/replies";
import { loadFilterConfig, loadStockDirectory } from "@/lib/forum/data/filterConfig";
import { ok, fail, handleForumError, readJsonBody } from "@/lib/forum/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { profileId } = await requireForumAccess(request);
    const { id } = await params;
    const body = await readJsonBody(request);
    const newBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!newBody) return fail("body 為必填。");

    const reply = await editReply(id, profileId, newBody, loadFilterConfig(), loadStockDirectory());
    return ok(reply);
  } catch (e) {
    return handleForumError(e);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { profileId } = await requireForumAccess(request);
    const { id } = await params;
    await deleteOwnReply(id, profileId);
    return ok({ deleted: true });
  } catch (e) {
    return handleForumError(e);
  }
}
