import { ForumAccessDeniedError, forumAccessDenialMessage, forumAccessDenialStatus } from "./requestContext";
import { NicknameInvalidError, NicknameTakenError } from "./data/profiles";
import { RateLimitedError, DuplicateContentError } from "./data/rateLimits";
import { ContentBlockedError } from "./data/posts";
import { AlreadyReportedError } from "./data/reports";

// Error classes whose .message is already a safe, user-facing Traditional-Chinese string. Anything
// else (including raw DB driver errors) must NOT have its message echoed back to the client.
const USER_FACING_ERRORS = [
  NicknameInvalidError,
  NicknameTakenError,
  RateLimitedError,
  DuplicateContentError,
  ContentBlockedError,
  AlreadyReportedError,
];

export function ok(data: unknown, status = 200): Response {
  return Response.json({ data, error: null }, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(message: string, status = 400): Response {
  return Response.json({ data: null, error: { message } }, { status });
}

/** Maps known forum errors (access denial, rate limit, content block, etc.) to an HTTP response. */
export function handleForumError(e: unknown): Response {
  if (e instanceof ForumAccessDeniedError) {
    return fail(forumAccessDenialMessage(e.reason), forumAccessDenialStatus(e.reason));
  }
  if (USER_FACING_ERRORS.some((ErrorClass) => e instanceof ErrorClass)) {
    return fail((e as Error).message, 400);
  }
  if (e instanceof Error) {
    console.error("[forum] unexpected error:", e);
  }
  return fail("發生未預期的錯誤，請稍後再試。", 500);
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
