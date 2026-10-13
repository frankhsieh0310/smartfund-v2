// Shared server-side gate every forum API route must go through (decision: "所有 API 都要在伺服器端
//檢查付費身分與停權狀態", week-2 instructions). Never trust a client-supplied "is paid"/"is suspended"
// flag — always re-derive from the DB here.

import { getAccountForRequest } from "@/lib/auth/userService";
import { getMembershipStatus } from "./membership/db";
import { getProfileByUserId, isCurrentlySuspended } from "./data/profiles";
import { hasAcceptedRuleVersion } from "./data/ruleAcceptance";
import { CURRENT_FORUM_RULE_VERSION } from "./ruleVersion";

export type ForumAccessDenialReason =
  | "UNAUTHENTICATED"
  | "NOT_A_MEMBER"
  | "NO_PROFILE"
  | "SUSPENDED"
  | "RULES_NOT_ACCEPTED";

export class ForumAccessDeniedError extends Error {
  readonly reason: ForumAccessDenialReason;
  constructor(reason: ForumAccessDenialReason) {
    super(reason);
    this.reason = reason;
  }
}

export interface ForumRequestContext {
  userId: string;
  profileId: string;
}

/**
 * Resolves the full forum access context for a request: authenticated, paying member, has a forum
 * profile, not suspended/banned, and has accepted the current rule version. Throws
 * ForumAccessDeniedError with a specific reason otherwise — callers map reasons to HTTP responses.
 */
export async function requireForumAccess(request: Request): Promise<ForumRequestContext> {
  const account = await getAccountForRequest(request);
  if (!account) throw new ForumAccessDeniedError("UNAUTHENTICATED");

  const membership = await getMembershipStatus(account.id);
  if (membership?.status !== "ACTIVE") throw new ForumAccessDeniedError("NOT_A_MEMBER");

  const profile = await getProfileByUserId(account.id);
  if (!profile) throw new ForumAccessDeniedError("NO_PROFILE");
  if (profile.status === "SUSPENDED" || profile.status === "BANNED" || profile.status === "DELETED") {
    throw new ForumAccessDeniedError("SUSPENDED");
  }

  const accepted = await hasAcceptedRuleVersion(profile.id, CURRENT_FORUM_RULE_VERSION);
  if (!accepted) throw new ForumAccessDeniedError("RULES_NOT_ACCEPTED");

  return { userId: account.id, profileId: profile.id };
}

/**
 * A lighter check used by endpoints that only need "is this a paying member" (e.g. viewing channel
 * lists before a forum profile/nickname exists yet) without requiring a profile or rule acceptance.
 */
export async function requireActiveMembership(request: Request): Promise<{ userId: string }> {
  const account = await getAccountForRequest(request);
  if (!account) throw new ForumAccessDeniedError("UNAUTHENTICATED");

  const membership = await getMembershipStatus(account.id);
  if (membership?.status !== "ACTIVE") throw new ForumAccessDeniedError("NOT_A_MEMBER");

  return { userId: account.id };
}

export async function requireSuspensionCheckedProfile(userId: string): Promise<{ profileId: string }> {
  const profile = await getProfileByUserId(userId);
  if (!profile) throw new ForumAccessDeniedError("NO_PROFILE");
  if (await isCurrentlySuspended(profile.id)) throw new ForumAccessDeniedError("SUSPENDED");
  return { profileId: profile.id };
}

export function forumAccessDenialStatus(reason: ForumAccessDenialReason): number {
  switch (reason) {
    case "UNAUTHENTICATED":
      return 401;
    case "NOT_A_MEMBER":
    case "SUSPENDED":
      return 403;
    case "NO_PROFILE":
    case "RULES_NOT_ACCEPTED":
      return 409;
  }
}

export function forumAccessDenialMessage(reason: ForumAccessDenialReason): string {
  switch (reason) {
    case "UNAUTHENTICATED":
      return "請先登入。";
    case "NOT_A_MEMBER":
      return "此功能僅限付費會員使用。";
    case "NO_PROFILE":
      return "請先設定討論區暱稱。";
    case "SUSPENDED":
      return "你的討論區帳號目前無法使用，如有疑問請透過客服信箱申訴。";
    case "RULES_NOT_ACCEPTED":
      return "請先閱讀並同意最新版討論區規範。";
  }
}
