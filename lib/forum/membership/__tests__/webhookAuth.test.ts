import assert from "node:assert/strict";
import { isAuthorizedRevenueCatWebhook } from "../webhookAuth.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test("isAuthorizedRevenueCatWebhook: matching header passes", () => {
  assert.equal(isAuthorizedRevenueCatWebhook("shared-secret-123", "shared-secret-123"), true);
});

test("isAuthorizedRevenueCatWebhook: mismatched header fails", () => {
  assert.equal(isAuthorizedRevenueCatWebhook("wrong", "shared-secret-123"), false);
});

test("isAuthorizedRevenueCatWebhook: missing header fails closed", () => {
  assert.equal(isAuthorizedRevenueCatWebhook(null, "shared-secret-123"), false);
});

test("isAuthorizedRevenueCatWebhook: unconfigured expected secret fails closed (never skips validation)", () => {
  assert.equal(isAuthorizedRevenueCatWebhook("anything", undefined), false);
  assert.equal(isAuthorizedRevenueCatWebhook("anything", ""), false);
});

test("isAuthorizedRevenueCatWebhook: different-length strings fail without throwing", () => {
  assert.equal(isAuthorizedRevenueCatWebhook("short", "a-much-longer-secret-value"), false);
});
