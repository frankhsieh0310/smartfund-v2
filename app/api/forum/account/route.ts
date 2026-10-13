import { getAccountForRequest } from "@/lib/auth/userService";
import { ForumAccessDeniedError } from "@/lib/forum/requestContext";
import { getProfileByUserId, deleteForumAccount } from "@/lib/forum/data/profiles";
import { ok, fail, handleForumError } from "@/lib/forum/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deletes the caller's forum account (decision 9: application-layer content clearing, not a DB cascade). */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const account = await getAccountForRequest(request);
    if (!account) throw new ForumAccessDeniedError("UNAUTHENTICATED");

    const profile = await getProfileByUserId(account.id);
    if (!profile) return fail("尚未建立討論區帳號。", 404);

    await deleteForumAccount(profile.id);
    return ok({ deleted: true });
  } catch (e) {
    return handleForumError(e);
  }
}
