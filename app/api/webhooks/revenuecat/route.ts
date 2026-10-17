// RevenueCat webhook: syncs entitlement changes to User.plan. Pure planning-to-code step (per the
// user's 2026-10-18 decision) -- RevenueCat project/products/pricing are NOT set up yet; this route
// is ready and Preview-tested, but has nothing real to receive until that account exists.
//
// Auth: RevenueCat sends `Authorization: Bearer <secret>` when a shared secret is configured on the
// webhook in the RevenueCat dashboard -- REVENUECAT_WEBHOOK_SECRET must match exactly what's entered
// there. No secret set locally means this route 401s everything, same shadow-safe default as every
// other new integration this round.
//
// Entitlement -> Plan mapping below is a PROVISIONAL SCAFFOLD, not a final decision: the user has
// explicitly said the final plan/pricing/entitlement names are still to be decided in the App Store/
// Play Console/RevenueCat dashboards. Update ENTITLEMENT_TO_PLAN once those are set -- do not treat
// this mapping as settled.
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENTITLEMENT_TO_PLAN: Record<string, "FREE" | "PREMIUM" | "TEAM"> = {
  // placeholder identifiers -- rename once real entitlements exist in RevenueCat
  premium: "PREMIUM",
  pro: "PREMIUM",
  team: "TEAM",
};

type RevenueCatEvent = {
  event: {
    type: string; // INITIAL_PURCHASE | RENEWAL | CANCELLATION | EXPIRATION | ... (see RC docs)
    app_user_id: string; // we configure the SDK with this = users.supabase_id
    entitlement_ids?: string[];
    entitlement_id?: string;
  };
};

function isAuthorized(request: Request): boolean {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function resolvePlan(entitlementIds: string[]): "FREE" | "PREMIUM" | "TEAM" | null {
  for (const id of entitlementIds) {
    const plan = ENTITLEMENT_TO_PLAN[id.toLowerCase()];
    if (plan) return plan;
  }
  return null;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: RevenueCatEvent;
  try {
    body = (await request.json()) as RevenueCatEvent;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const event = body.event;
  if (!event?.app_user_id || !event?.type) {
    return Response.json({ ok: false, error: "Missing event.app_user_id/type" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { supabaseId: event.app_user_id }, select: { id: true } });
  if (!user) {
    // Not an error -- a webhook can arrive for a RevenueCat anonymous/test user that never
    // completed our own signup. Acknowledge so RevenueCat doesn't keep retrying.
    return Response.json({ ok: true, matched: false });
  }

  const isActiveEvent = ["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE"].includes(event.type);
  const isInactiveEvent = ["CANCELLATION", "EXPIRATION", "BILLING_ISSUE"].includes(event.type);

  if (isActiveEvent) {
    const entitlementIds = event.entitlement_ids ?? (event.entitlement_id ? [event.entitlement_id] : []);
    const plan = resolvePlan(entitlementIds);
    if (plan) await prisma.user.update({ where: { id: user.id }, data: { plan } });
    return Response.json({ ok: true, matched: true, plan });
  }
  if (isInactiveEvent) {
    await prisma.user.update({ where: { id: user.id }, data: { plan: "FREE" } });
    return Response.json({ ok: true, matched: true, plan: "FREE" });
  }
  return Response.json({ ok: true, matched: true, ignored: event.type });
}
