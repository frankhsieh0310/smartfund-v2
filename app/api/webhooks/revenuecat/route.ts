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
//
// 2026-10-18 固定範圍第 2 項 (14 天免費試用): also records TRIAL_STARTED/FIRST_PAYMENT/
// SECOND_PAYMENT_MONTHLY into usage_funnel_events (item 5's funnel table) from real RevenueCat
// events, instead of the App having to guess at subscription state client-side. Per RevenueCat's
// own event model there is NO "TRIAL_STARTED" event type -- a trial start is an INITIAL_PURCHASE
// whose period_type is "TRIAL"; if the trial converts, the first REAL charge arrives as a
// subsequent RENEWAL event, not as INITIAL_PURCHASE again. PRODUCT_ID_TO_PERIOD below is the same
// kind of provisional scaffold as ENTITLEMENT_TO_PLAN -- "年繳續訂不列入近期指標" (the user's
// explicit requirement) is enforced by only ever writing SECOND_PAYMENT_MONTHLY when the paying
// product's period is confirmed MONTHLY, never for an unmapped/unknown product.
//
// NONE of this has been exercised against a real event yet -- RevenueCat products don't exist in
// App Store Connect/Google Play Console yet, so this logic is unverified against real payloads
// and must be re-checked once a real sandbox purchase happens. See CLAUDE.md's 第 2 項 entry.
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENTITLEMENT_TO_PLAN: Record<string, "FREE" | "PREMIUM" | "TEAM"> = {
  // placeholder identifiers -- rename once real entitlements exist in RevenueCat
  premium: "PREMIUM",
  pro: "PREMIUM",
  team: "TEAM",
};

// placeholder product ids -- rename once real products exist in App Store Connect/Play Console.
const PRODUCT_ID_TO_PERIOD: Record<string, "MONTHLY" | "ANNUAL"> = {
  premium_monthly: "MONTHLY",
  premium_annual: "ANNUAL",
};

type RevenueCatEvent = {
  event: {
    type: string; // INITIAL_PURCHASE | RENEWAL | CANCELLATION | EXPIRATION | ... (see RC docs)
    app_user_id: string; // we configure the SDK with this = users.supabase_id
    entitlement_ids?: string[];
    entitlement_id?: string;
    period_type?: string; // TRIAL | INTRO | NORMAL | PROMOTIONAL
    product_id?: string;
    store?: string;
  };
};

async function recordFunnelEvent(userId: string, eventType: "TRIAL_STARTED" | "FIRST_PAYMENT" | "SECOND_PAYMENT_MONTHLY", metadata: Record<string, unknown>) {
  // device_id is NOT NULL on usage_funnel_events but this event arrives server-side with no device
  // context -- a synthetic per-user key keeps the funnel's per-identity grouping (coalesce(user_id,
  // device_id) in the funnel-report query) correct without needing a real device id here.
  await prisma.$executeRawUnsafe(
    `INSERT INTO usage_funnel_events (device_id, user_id, event_type, source_type, metadata) VALUES ($1, $2::uuid, $3, 'UNKNOWN', $4::jsonb)`,
    `server:revenuecat:${userId}`, userId, eventType, JSON.stringify(metadata),
  );
}

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

    // 第 2+5 項: funnel events, best-effort -- a tracking failure must never fail the plan update above.
    try {
      if (event.type === "INITIAL_PURCHASE" && event.period_type === "TRIAL") {
        await recordFunnelEvent(user.id, "TRIAL_STARTED", { productId: event.product_id, store: event.store });
      } else {
        // A real charge: either a non-trial INITIAL_PURCHASE, or the RENEWAL that follows a
        // trial's conversion. Count this user's prior funnel events to tell first charge from
        // a later renewal, rather than trusting RevenueCat's event type alone.
        const prior = await prisma.$queryRawUnsafe<Array<{ event_type: string }>>(
          `SELECT event_type FROM usage_funnel_events WHERE user_id = $1::uuid AND event_type IN ('FIRST_PAYMENT', 'SECOND_PAYMENT_MONTHLY')`,
          user.id,
        );
        const hasFirstPayment = prior.some((r) => r.event_type === "FIRST_PAYMENT");
        const hasSecondPayment = prior.some((r) => r.event_type === "SECOND_PAYMENT_MONTHLY");
        const period = event.product_id ? PRODUCT_ID_TO_PERIOD[event.product_id] : undefined;
        if (!hasFirstPayment) {
          await recordFunnelEvent(user.id, "FIRST_PAYMENT", { productId: event.product_id, store: event.store, period: period ?? "UNKNOWN" });
        } else if (!hasSecondPayment && event.type === "RENEWAL" && period === "MONTHLY") {
          // "年繳續訂不列入近期指標" -- period must be confirmed MONTHLY, never fired for ANNUAL
          // or an unmapped product.
          await recordFunnelEvent(user.id, "SECOND_PAYMENT_MONTHLY", { productId: event.product_id, store: event.store });
        }
      }
    } catch (err) {
      console.error("RevenueCat webhook funnel tracking failed", err);
    }

    return Response.json({ ok: true, matched: true, plan });
  }
  if (isInactiveEvent) {
    await prisma.user.update({ where: { id: user.id }, data: { plan: "FREE" } });
    return Response.json({ ok: true, matched: true, plan: "FREE" });
  }
  return Response.json({ ok: true, matched: true, ignored: event.type });
}
