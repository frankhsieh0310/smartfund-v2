import assert from "node:assert/strict";
import { checkPriceSanity } from "../priceSanity.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("IFFFL.XC real scenario: 72.4 (new) vs 7240 (last known) — ratio 0.01 — caught as UNIT_MISMATCH", () => {
  assert.equal(checkPriceSanity(72.4, 7240), "UNIT_MISMATCH");
});

test("IFFFL.XC reversed: 7240 (new) vs 72.4 (last known) — ratio 100 — caught symmetrically either direction", () => {
  assert.equal(checkPriceSanity(7240, 72.4), "UNIT_MISMATCH");
});

test("normal +3% move is NOT caught by either check", () => {
  assert.equal(checkPriceSanity(103, 100), null);
});

test("normal -3% move is NOT caught by either check", () => {
  assert.equal(checkPriceSanity(97, 100), null);
});

test("a volatile but genuine ±10% day is NOT caught", () => {
  assert.equal(checkPriceSanity(110, 100), null);
  assert.equal(checkPriceSanity(90, 100), null);
});

test("a +50% move exactly at the boundary is NOT flagged (strictly greater than 50%, not at-or-above)", () => {
  assert.equal(checkPriceSanity(150, 100), null);
});

test("a +51% move is flagged PRICE_JUMP_REVIEW", () => {
  assert.equal(checkPriceSanity(151, 100), "PRICE_JUMP_REVIEW");
});

test("a -51% move (more than halved) is flagged PRICE_JUMP_REVIEW", () => {
  assert.equal(checkPriceSanity(49, 100), "PRICE_JUMP_REVIEW");
});

test("no last known close at all (e.g. a genuinely new listing) -> never flagged, nothing to compare against", () => {
  assert.equal(checkPriceSanity(7240, null), null);
});

test("UNIT_MISMATCH takes priority over PRICE_JUMP_REVIEW when both thresholds would technically apply", () => {
  // ratio 100 would also trivially exceed the 50% jump threshold, but UNIT_MISMATCH is the more
  // specific, more useful diagnosis and must win.
  assert.equal(checkPriceSanity(10000, 100), "UNIT_MISMATCH");
});

test("a ratio just outside the unit-mismatch band (e.g. 94x) falls through to PRICE_JUMP_REVIEW instead", () => {
  assert.equal(checkPriceSanity(9400, 100), "PRICE_JUMP_REVIEW");
});

console.log("PRICE_SANITY_TESTS_DONE");
