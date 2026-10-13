import assert from "node:assert/strict";
import { mapRevenueCatEventToMembershipUpdate } from "../events.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test("INITIAL_PURCHASE with a future expiration activates membership", () => {
  const result = mapRevenueCatEventToMembershipUpdate({
    event: { type: "INITIAL_PURCHASE", app_user_id: "u1", expiration_at_ms: Date.now() + 86_400_000 },
  });
  assert.equal(result?.status, "ACTIVE");
  assert.equal(result?.appUserId, "u1");
});

test("RENEWAL with a future expiration activates membership", () => {
  const result = mapRevenueCatEventToMembershipUpdate({
    event: { type: "RENEWAL", app_user_id: "u1", expiration_at_ms: Date.now() + 86_400_000 },
  });
  assert.equal(result?.status, "ACTIVE");
});

test("an activating event whose expiration is already in the past is reported as EXPIRED, not trusted blindly", () => {
  const result = mapRevenueCatEventToMembershipUpdate({
    event: { type: "RENEWAL", app_user_id: "u1", expiration_at_ms: Date.now() - 1000 },
  });
  assert.equal(result?.status, "EXPIRED");
});

test("CANCELLATION deactivates membership", () => {
  const result = mapRevenueCatEventToMembershipUpdate({
    event: { type: "CANCELLATION", app_user_id: "u1", expiration_at_ms: Date.now() + 86_400_000 },
  });
  assert.equal(result?.status, "EXPIRED");
});

test("EXPIRATION deactivates membership", () => {
  const result = mapRevenueCatEventToMembershipUpdate({
    event: { type: "EXPIRATION", app_user_id: "u1" },
  });
  assert.equal(result?.status, "EXPIRED");
});

test("BILLING_ISSUE deactivates membership", () => {
  const result = mapRevenueCatEventToMembershipUpdate({
    event: { type: "BILLING_ISSUE", app_user_id: "u1" },
  });
  assert.equal(result?.status, "EXPIRED");
});

test("an unrecognized event type returns null so the caller can safely ignore it", () => {
  const result = mapRevenueCatEventToMembershipUpdate({
    event: { type: "TEST", app_user_id: "u1" },
  });
  assert.equal(result, null);
});

test("a payload missing app_user_id returns null", () => {
  const result = mapRevenueCatEventToMembershipUpdate({
    event: { type: "INITIAL_PURCHASE", app_user_id: "" },
  });
  assert.equal(result, null);
});

test("an activating event with no expiration (e.g. lifetime/non-subscription) activates with null expiresAt", () => {
  const result = mapRevenueCatEventToMembershipUpdate({
    event: { type: "INITIAL_PURCHASE", app_user_id: "u1" },
  });
  assert.equal(result?.status, "ACTIVE");
  assert.equal(result?.expiresAt, null);
});
