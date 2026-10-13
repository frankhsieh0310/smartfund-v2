import { getAccountForRequest } from "@/lib/auth/userService";
import { requireActiveMembership, ForumAccessDeniedError } from "@/lib/forum/requestContext";
import { getProfileByUserId, createProfile, validateNicknameShape, validateNicknameContent } from "@/lib/forum/data/profiles";
import { loadFilterConfig, loadStockDirectory } from "@/lib/forum/data/filterConfig";
import { ok, fail, handleForumError, readJsonBody } from "@/lib/forum/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const account = await getAccountForRequest(request);
    if (!account) throw new ForumAccessDeniedError("UNAUTHENTICATED");

    const profile = await getProfileByUserId(account.id);
    if (!profile) return ok(null);
    return ok({ nickname: profile.nickname, status: profile.status });
  } catch (e) {
    return handleForumError(e);
  }
}

/** Sets up a forum profile (nickname) for the first time. Membership is required, but a profile need not exist yet. */
export async function POST(request: Request): Promise<Response> {
  try {
    const { userId } = await requireActiveMembership(request);

    const existing = await getProfileByUserId(userId);
    if (existing) return fail("你已經設定過討論區暱稱了。", 409);

    const body = await readJsonBody(request);
    const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";

    validateNicknameShape(nickname);
    validateNicknameContent(nickname, loadFilterConfig(), loadStockDirectory());

    const profile = await createProfile(userId, nickname);
    return ok({ nickname: profile.nickname, status: profile.status }, 201);
  } catch (e) {
    return handleForumError(e);
  }
}
