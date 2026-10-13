import assert from "node:assert/strict";
import { checkOffshoreNavSanity } from "../navSanity.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("checkOffshoreNavSanity: no prior nav -> OK (nothing to compare)", () => {
  assert.equal(checkOffshoreNavSanity(10, null), "OK");
});
test("checkOffshoreNavSanity: 10% move -> OK", () => {
  assert.equal(checkOffshoreNavSanity(11, 10), "OK");
});
test("checkOffshoreNavSanity: exactly 20% move -> OK (boundary)", () => {
  assert.equal(checkOffshoreNavSanity(12, 10), "OK");
});
test("checkOffshoreNavSanity: >20% move -> JUMP_REVIEW", () => {
  assert.equal(checkOffshoreNavSanity(13, 10), "JUMP_REVIEW");
});
test("checkOffshoreNavSanity: >20% drop -> JUMP_REVIEW", () => {
  assert.equal(checkOffshoreNavSanity(7, 10), "JUMP_REVIEW");
});
