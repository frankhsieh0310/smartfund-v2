// Single source of truth for subscription tiers, pricing, and which features sit behind the
// paywall. Payment itself happens in the mobile App only (RevenueCat native SDK -- see
// smartmatch-mobile/src/payments/revenuecat.ts and docs/setup/revenuecat-store-setup.md there);
// this module exists so the shared backend (smartfund-v2) can compute each user's access tier
// server-side and both the website and the App read the same feature list instead of each
// hardcoding its own copy.
//
// RevenueCat entitlement/product setup is NOT done yet (no NEXT_PUBLIC_REVENUECAT_API_KEY /
// EXPO_PUBLIC_REVENUECAT_API_KEY_* set anywhere as of 2026-10-24) -- see that doc for the exact
// steps. TRIAL_DAYS and the two TWD prices below must match what gets configured there exactly;
// if the user changes either in the App Store Connect / Google Play / RevenueCat dashboards,
// update them here too.

export const TRIAL_DAYS = 14;
export const PRICE_MONTHLY_TWD = 129;
export const PRICE_YEARLY_TWD = 1190;

/** Feature keys are stable identifiers used in UI gating checks -- rename carefully, both repos
 * reference the same strings (this file in smartfund-v2, the mirrored list in
 * smartmatch-mobile/src/payments/plans.ts). */
export const FREE_FEATURES = [
  "search",
  "detail_page",
  "technical_analysis",
  "ranking",
  "dividend_info_and_calculator",
  "compare",
  "new_listings",
  "investment_calendar",
] as const;

export const PAID_FEATURES = [
  "portfolio_lookthrough",
  "stock_bond_commodity_reverse_lookup",
  "technical_screener_reverse_lookup",
  "active_etf_holdings_and_changes",
  "alerts",
  "institutional_activity_and_consensus_radar",
  "saved_multiple_portfolios",
] as const;

export type FeatureKey = (typeof FREE_FEATURES)[number] | (typeof PAID_FEATURES)[number];

export type AccessTier = "trial" | "paid" | "free";

/** `plan` is the Prisma `Plan` enum (`FREE` | `PREMIUM` | `TEAM`); `createdAt` is `User.createdAt`.
 * TEAM is treated as paid (full access) alongside PREMIUM -- this spec only defines a free/paid
 * split, TEAM is an existing schema value from before this round, not redefined here. */
export function getAccessTier(user: { plan: "FREE" | "PREMIUM" | "TEAM"; createdAt: Date | string }): AccessTier {
  if (user.plan === "PREMIUM" || user.plan === "TEAM") return "paid";
  const createdAt = typeof user.createdAt === "string" ? new Date(user.createdAt) : user.createdAt;
  const trialEndsAt = new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  return Date.now() < trialEndsAt.getTime() ? "trial" : "free";
}

export function getTrialEndsAt(createdAt: Date | string): Date {
  const created = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  return new Date(created.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

/** trial and paid tiers see everything; free tier (trial expired, never subscribed) only sees
 * FREE_FEATURES. */
export function canAccessFeature(tier: AccessTier, feature: FeatureKey): boolean {
  if (tier === "trial" || tier === "paid") return true;
  return (FREE_FEATURES as readonly string[]).includes(feature);
}
