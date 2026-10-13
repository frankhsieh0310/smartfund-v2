import { requireActiveMembership } from "@/lib/forum/requestContext";
import { getProfileByUserId } from "@/lib/forum/data/profiles";
import { acceptRuleVersion } from "@/lib/forum/data/ruleAcceptance";
import { CURRENT_FORUM_RULE_VERSION } from "@/lib/forum/ruleVersion";
import { ok, fail, handleForumError } from "@/lib/forum/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const { userId } = await requireActiveMembership(request);
    const profile = await getProfileByUserId(userId);
    if (!profile) return fail("請先設定討論區暱稱。", 409);

    await acceptRuleVersion(profile.id, CURRENT_FORUM_RULE_VERSION);
    return ok({ ruleVersion: CURRENT_FORUM_RULE_VERSION, acceptedAt: new Date().toISOString() });
  } catch (e) {
    return handleForumError(e);
  }
}
