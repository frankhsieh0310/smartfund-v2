import { requireActiveMembership } from "@/lib/forum/requestContext";
import { listChannels } from "@/lib/forum/data/channels";
import { ok, handleForumError } from "@/lib/forum/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireActiveMembership(request);
    return ok(await listChannels());
  } catch (e) {
    return handleForumError(e);
  }
}
