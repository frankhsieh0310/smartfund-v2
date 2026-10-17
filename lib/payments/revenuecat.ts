// RevenueCat Web Billing integration (client-side helper). Per the user's 2026-10-18 decision: build
// the integration code now in Preview; the RevenueCat project, products, and final pricing are set
// up by the user later in the App Store/Play Console/RevenueCat dashboards.
//
// NOT wired into app/pricing/page.tsx yet -- that page currently has no logged-in-session plumbing
// at all (its "登入" link is a bare `href="#"` placeholder, and no web page in this app calls
// /api/me client-side). RevenueCat's Web SDK requires an identified (non-anonymous) app_user_id to
// configure purchases against (https://www.revenuecat.com/docs/web/web-billing/web-sdk) -- wiring
// the pricing buttons to a real purchase call before that session exists would mean inventing a fake
// user id, which is exactly the kind of thing not to do. This module is the ready-to-use integration
// layer; call `purchasePackage` once the page has a real, authenticated user id to pass in.
"use client";

import { Purchases, LogLevel } from "@revenuecat/purchases-js";

let configured: InstanceType<typeof Purchases> | null = null;

export function isRevenueCatConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_REVENUECAT_API_KEY);
}

/** Configures the SDK once per `appUserId` (RevenueCat requires re-configuring when the identified
 * user changes, e.g. after login/logout). `appUserId` should be the SmartMatch user's stable
 * identifier (users.supabase_id) -- never an invented or anonymous value. */
export function configureRevenueCat(appUserId: string): InstanceType<typeof Purchases> {
  const apiKey = process.env.NEXT_PUBLIC_REVENUECAT_API_KEY;
  if (!apiKey) throw new Error("NEXT_PUBLIC_REVENUECAT_API_KEY not set -- RevenueCat project not created yet");
  if (process.env.NODE_ENV !== "production") Purchases.setLogLevel(LogLevel.Debug);
  configured = Purchases.configure({ apiKey, appUserId });
  return configured;
}

export type OfferingPackage = { identifier: string; priceString: string; title: string };

export async function listOfferingPackages(appUserId: string): Promise<OfferingPackage[]> {
  const purchases = configured ?? configureRevenueCat(appUserId);
  const offerings = await purchases.getOfferings();
  const current = offerings.current;
  if (!current) return [];
  return current.availablePackages.map((pkg) => ({
    identifier: pkg.identifier,
    priceString: pkg.rcBillingProduct.currentPrice.formattedPrice,
    title: pkg.rcBillingProduct.title,
  }));
}

export type PurchaseOutcome = { ok: true; entitlements: string[] } | { ok: false; error: string };

export async function purchasePackage(appUserId: string, packageIdentifier: string): Promise<PurchaseOutcome> {
  try {
    const purchases = configured ?? configureRevenueCat(appUserId);
    const offerings = await purchases.getOfferings();
    const pkg = offerings.current?.availablePackages.find((p) => p.identifier === packageIdentifier);
    if (!pkg) return { ok: false, error: "方案目前無法購買，請稍後再試。" };
    const result = await purchases.purchase({ rcPackage: pkg });
    const entitlements = Object.keys(result.customerInfo.entitlements.active);
    return { ok: true, entitlements };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "購買失敗，請稍後再試。" };
  }
}
