import assert from "node:assert/strict";
import { isAuthorizedTelegramWebhook, isWhitelistedChat } from "../auth.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test("isAuthorizedTelegramWebhook: matching secret token passes", () => {
  assert.equal(isAuthorizedTelegramWebhook("my-secret", "my-secret"), true);
});

test("isAuthorizedTelegramWebhook: mismatched secret fails", () => {
  assert.equal(isAuthorizedTelegramWebhook("wrong", "my-secret"), false);
});

test("isAuthorizedTelegramWebhook: missing header fails closed", () => {
  assert.equal(isAuthorizedTelegramWebhook(null, "my-secret"), false);
});

test("isAuthorizedTelegramWebhook: unconfigured secret fails closed", () => {
  assert.equal(isAuthorizedTelegramWebhook("anything", undefined), false);
});

test("isWhitelistedChat: the configured admin chat id is accepted", () => {
  assert.equal(isWhitelistedChat(123456789, "123456789"), true);
});

test("isWhitelistedChat: any other chat id is rejected", () => {
  assert.equal(isWhitelistedChat(999999999, "123456789"), false);
});

test("isWhitelistedChat: missing chat id or unconfigured whitelist both fail closed", () => {
  assert.equal(isWhitelistedChat(undefined, "123456789"), false);
  assert.equal(isWhitelistedChat(123456789, undefined), false);
});
