// Maps RevenueCat webhook event payloads to our internal membership status.
// Reference: RevenueCat webhook event types (https://www.revenuecat.com/docs/integrations/webhooks).

export type MembershipStatus = "ACTIVE" | "EXPIRED";

export interface RevenueCatWebhookEvent {
  event: {
    type: string;
    app_user_id: string;
    expiration_at_ms?: number | null;
    entitlement_ids?: string[];
  };
}

// Event types that grant/continue membership vs. ones that end it.
const ACTIVATING_EVENT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "SUBSCRIPTION_EXTENDED",
]);
const DEACTIVATING_EVENT_TYPES = new Set([
  "CANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
]);

export interface MembershipUpdate {
  appUserId: string;
  status: MembershipStatus;
  expiresAt: Date | null;
}

/**
 * Pure mapping from a webhook event to the membership update we should apply.
 * Returns null for event types we don't act on (e.g. TEST, TRANSFER needs special handling later —
 * see spec pending-decision list) so the caller can safely ignore/log them instead of guessing.
 */
export function mapRevenueCatEventToMembershipUpdate(
  payload: RevenueCatWebhookEvent,
): MembershipUpdate | null {
  const { type, app_user_id, expiration_at_ms } = payload.event;
  if (!app_user_id) return null;

  const expiresAt = expiration_at_ms ? new Date(expiration_at_ms) : null;

  if (ACTIVATING_EVENT_TYPES.has(type)) {
    // An activating event with an expiration already in the past (e.g. a delayed webhook) should not
    // grant access — server-side status is always re-derived from expiresAt, never trusted blindly.
    const stillActive = expiresAt === null || expiresAt.getTime() > Date.now();
    return {
      appUserId: app_user_id,
      status: stillActive ? "ACTIVE" : "EXPIRED",
      expiresAt,
    };
  }

  if (DEACTIVATING_EVENT_TYPES.has(type)) {
    return { appUserId: app_user_id, status: "EXPIRED", expiresAt };
  }

  return null;
}
