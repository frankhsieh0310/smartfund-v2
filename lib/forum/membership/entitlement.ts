// Shared entitlement check used by both the app's own API routes and (later) the forum's own
// endpoints: "is this request's authenticated user currently a paying member?" Always goes through
// this function — per the user's decision, membership must be verified server-side, never trusted
// from the client.

import { getAccountForRequest } from "@/lib/auth/userService";
import { getMembershipStatus } from "./db";

export interface ForumMembership {
  userId: string;
  active: boolean;
  expiresAt: Date | null;
}

/**
 * Resolves the current request's forum membership. Returns null if the request isn't authenticated
 * at all (distinct from "authenticated but not a member", which returns active: false).
 */
export async function getForumMembershipForRequest(request: Request): Promise<ForumMembership | null> {
  const account = await getAccountForRequest(request);
  if (!account) return null;

  const membership = await getMembershipStatus(account.id);
  return {
    userId: account.id,
    active: membership?.status === "ACTIVE",
    expiresAt: membership?.expiresAt ?? null,
  };
}
