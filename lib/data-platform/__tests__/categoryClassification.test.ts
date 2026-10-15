import assert from "node:assert/strict";
import { classifyCategory } from "../categoryClassification.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("null/undefined -> UNCLASSIFIED, never guesses", () => {
  assert.equal(classifyCategory(null), "UNCLASSIFIED");
  assert.equal(classifyCategory(undefined), "UNCLASSIFIED");
  assert.equal(classifyCategory(""), "UNCLASSIFIED");
});

test("equity categories -> STOCK", () => {
  assert.equal(classifyCategory("Large Blend"), "STOCK");
  assert.equal(classifyCategory("股票型"), "STOCK");
  assert.equal(classifyCategory("Foreign Large Growth"), "STOCK");
});

test("bond categories -> BOND", () => {
  assert.equal(classifyCategory("High Yield Bond"), "BOND");
  assert.equal(classifyCategory("固定收益型"), "BOND");
  assert.equal(classifyCategory("Muni National Long"), "BOND");
});

test("commodity categories -> COMMODITY", () => {
  assert.equal(classifyCategory("Commodities Broad Basket"), "COMMODITY");
  assert.equal(classifyCategory("Trading--Leveraged Commodities"), "COMMODITY");
});

test("genuinely mixed-asset categories -> MIXED, not forced into STOCK or BOND", () => {
  assert.equal(classifyCategory("Allocation--50% to 70% Equity"), "MIXED");
  assert.equal(classifyCategory("Target-Date 2050"), "MIXED");
  assert.equal(classifyCategory("跨國投資多重資產型"), "MIXED");
});

test("an unmapped category value -> UNCLASSIFIED, never silently assigned a bucket", () => {
  assert.equal(classifyCategory("MUTUAL_FUND"), "UNCLASSIFIED");
  assert.equal(classifyCategory("跨國投資指數型"), "UNCLASSIFIED");
  assert.equal(classifyCategory("some-never-seen-value"), "UNCLASSIFIED");
});

test("no category value is double-mapped to two different buckets", () => {
  // Re-import the raw sets isn't exported; instead sanity-check a few known boundary cases that
  // looked like near-duplicates during authoring (World Large-Stock Blend / World Small/Mid Stock
  // were accidentally in both STOCK and MIXED at one point this round — guard the fix).
  assert.equal(classifyCategory("World Large-Stock Blend"), "STOCK");
  assert.equal(classifyCategory("World Small/Mid Stock"), "STOCK");
});
