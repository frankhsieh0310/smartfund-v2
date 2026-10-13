import { requireForumAccess } from "@/lib/forum/requestContext";
import { reportContent } from "@/lib/forum/data/reports";
import { ok, fail, handleForumError, readJsonBody } from "@/lib/forum/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const { profileId } = await requireForumAccess(request);
    const body = await readJsonBody(request);

    const targetType = body.targetType === "POST" || body.targetType === "REPLY" ? body.targetType : null;
    const targetId = typeof body.targetId === "string" ? body.targetId : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!targetType || !targetId || !reason) return fail("targetType、targetId 與 reason 皆為必填。");

    const result = await reportContent({ targetType, targetId, reporterId: profileId, reason });
    return ok(result, 201);
  } catch (e) {
    return handleForumError(e);
  }
}
