import { requireForumAccess } from "@/lib/forum/requestContext";
import { listPublishedPosts, createPost } from "@/lib/forum/data/posts";
import { getChannelById } from "@/lib/forum/data/channels";
import { loadFilterConfig, loadStockDirectory } from "@/lib/forum/data/filterConfig";
import { ok, fail, handleForumError, readJsonBody } from "@/lib/forum/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireForumAccess(request);
    const channelId = new URL(request.url).searchParams.get("channelId");
    if (!channelId) return fail("請指定 channelId。");

    return ok(await listPublishedPosts(channelId));
  } catch (e) {
    return handleForumError(e);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { profileId } = await requireForumAccess(request);
    const body = await readJsonBody(request);

    const channelId = typeof body.channelId === "string" ? body.channelId : null;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const postBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!channelId || !title || !postBody) return fail("channelId、title 與 body 皆為必填。");

    const channel = await getChannelById(channelId);
    if (!channel) return fail("頻道不存在。", 404);
    if (channel.officialOnly) return fail("此頻道僅限官方發文。", 403);

    const post = await createPost({
      profileId,
      channelId,
      title,
      body: postBody,
      filterConfig: loadFilterConfig(),
      stockDirectory: loadStockDirectory(),
    });
    return ok(post, 201);
  } catch (e) {
    return handleForumError(e);
  }
}
