import assert from "node:assert/strict";
import { checkNavSanity } from "../navSanity.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
  return p;
}

(async () => {
  test("checkNavSanity: no prior NAV -> null (nothing to compare against)", () => {
    assert.equal(checkNavSanity(10, null), null);
    assert.equal(checkNavSanity(10, 0), null);
  });

  test("checkNavSanity: a normal day's move (<=20%) clears both checks", () => {
    assert.equal(checkNavSanity(10.5, 10), null); // +5%
    assert.equal(checkNavSanity(8.5, 10), null); // -15%
  });

  test("checkNavSanity: ~100x ratio is UNIT_MISMATCH, either direction", () => {
    assert.equal(checkNavSanity(1000, 10), "UNIT_MISMATCH");
    assert.equal(checkNavSanity(10, 1000), "UNIT_MISMATCH");
  });

  test("checkNavSanity: >20% move that is NOT a unit mismatch is JUMP_REVIEW", () => {
    assert.equal(checkNavSanity(13, 10), "JUMP_REVIEW"); // +30%
    assert.equal(checkNavSanity(7, 10), "JUMP_REVIEW"); // -30%
  });

  test("checkNavSanity: stricter than priceSanity.ts's 50% threshold — Task Z asked for 20%", () => {
    assert.equal(checkNavSanity(12.5, 10), "JUMP_REVIEW"); // +25%, would pass a 50% threshold but not 20%
  });
})();
