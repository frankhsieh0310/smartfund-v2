// Shared membership-status endpoint used by the mobile app to decide whether to show forum content
// (paid-only viewing/posting per decision 1 in docs/specs/paid-member-forum-spec.md). The app must
// treat this as the source of truth and never fall back to a locally-cached "is paid" flag.
//
// Pending DDL approval: will 500 until forum.memberships exists (see db.ts for details).

import { getForumMembershipForRequest } from "@/lib/forum/membership/entitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const membership = await getForumMembershipForRequest(request);
  if (!membership) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  return Response.json(
    {
      active: membership.active,
      expiresAt: membership.expiresAt?.toISOString() ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
