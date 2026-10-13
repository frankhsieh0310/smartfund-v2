// Confirms the EXISTING lib/cron/authorize.ts (reused unmodified by this feature) fails closed when
// CRON_SECRET is unset — i.e. refuses every request rather than letting any through. This is the
// exact guard market-close-sync/route.ts relies on via isAuthorizedCron(), so it's verified here
// directly against the real function, not re-implemented.
import assert from "node:assert/strict";
import { isAuthorizedCron } from "../../cron/authorize.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const originalSecret = process.env.CRON_SECRET;
delete process.env.CRON_SECRET;

test("CRON_SECRET unset + no Authorization header => rejected", () => {
  const req = new Request("https://example.invalid/api/cron/market-close-sync");
  assert.equal(isAuthorizedCron(req), false);
});

test("CRON_SECRET unset + an Authorization header present (any value) => still rejected, never falls open", () => {
  const req = new Request("https://example.invalid/api/cron/market-close-sync", {
    headers: { authorization: "Bearer anything-at-all" },
  });
  assert.equal(isAuthorizedCron(req), false);
});

test("CRON_SECRET unset + literal 'Bearer undefined' (the classic footgun if the check were `=== 'Bearer ' + secret` without the !secret guard) => still rejected", () => {
  const req = new Request("https://example.invalid/api/cron/market-close-sync", {
    headers: { authorization: "Bearer undefined" },
  });
  assert.equal(isAuthorizedCron(req), false);
});

if (originalSecret !== undefined) process.env.CRON_SECRET = originalSecret;

console.log("AUTH_FAIL_CLOSED_TESTS_DONE");
