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
  assert.equal(classifyCategory("Commodities Focused"), "COMMODITY");
});

// 2026-11-10: 修正前的版本在這裡誤用"Trading--Leveraged Commodities"當作COMMODITY的例子——
// 但這個分類本來就被設計成LEVERAGE_INVERSE（槓桿/反向是操作手法、不是資產類別，見
// categoryClassification.ts的LEVERAGE_INVERSE_CATEGORIES註解），檢查順序也特意把
// LEVERAGE_INVERSE放在COMMODITY之前。程式本身沒有錯，是測試用錯例子。
test("leveraged/inverse commodity categories -> LEVERAGE_INVERSE, not COMMODITY (operating method, not asset class)", () => {
  assert.equal(classifyCategory("Trading--Leveraged Commodities"), "LEVERAGE_INVERSE");
  assert.equal(classifyCategory("Trading--Inverse Commodities"), "LEVERAGE_INVERSE");
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
