// RevenueCat webhook receiver. Updates forum membership status server-side so entitlement checks
// never depend on the client's own claim. Requires REVENUECAT_WEBHOOK_SECRET to be set to the same
// value configured in the RevenueCat dashboard's webhook Authorization header field.
//
// Pending DDL approval (docs/specs/forum-schema-draft.sql): this route will 500 on the DB write until
// the forum.memberships table exists. The auth check and event parsing/mapping work independently of
// the DB and are covered by unit tests in lib/forum/membership/__tests__.

import { isAuthorizedRevenueCatWebhook } from "@/lib/forum/membership/webhookAuth";
import { mapRevenueCatEventToMembershipUpdate, type RevenueCatWebhookEvent } from "@/lib/forum/membership/events";
import { upsertMembershipFromWebhook } from "@/lib/forum/membership/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorized = isAuthorizedRevenueCatWebhook(
    request.headers.get("authorization"),
    process.env.REVENUECAT_WEBHOOK_SECRET,
  );
  if (!authorized) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: RevenueCatWebhookEvent;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update = mapRevenueCatEventToMembershipUpdate(payload);
  if (!update) {
    // Event type we don't act on (e.g. TEST) — acknowledge so RevenueCat doesn't retry it.
    return Response.json({ received: true, applied: false });
  }

  await upsertMembershipFromWebhook({
    appUserId: update.appUserId,
    status: update.status,
    expiresAt: update.expiresAt,
  });

  return Response.json({ received: true, applied: true });
}
