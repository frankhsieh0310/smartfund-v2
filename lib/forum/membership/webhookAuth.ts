// RevenueCat webhook authentication: a static Authorization header configured in the RevenueCat
// dashboard. Fail closed — a missing/misconfigured expected value must reject every request, never
// skip validation. See docs/specs/launch-plan-30days.md for the official RevenueCat webhook docs link.

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of the request's Authorization header against the expected secret.
 * Returns false (never throws) for any missing/malformed input — callers must reject on false.
 */
export function isAuthorizedRevenueCatWebhook(
  authorizationHeader: string | null,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret) return false;
  if (!authorizationHeader) return false;

  const received = Buffer.from(authorizationHeader, "utf-8");
  const expected = Buffer.from(expectedSecret, "utf-8");
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}
