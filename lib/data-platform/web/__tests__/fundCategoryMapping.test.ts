import assert from "node:assert/strict";
import { mapFundMainCategory } from "../fundCategoryMapping.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("null/undefined/empty -> 其他, never guessed", () => {
  assert.equal(mapFundMainCategory(null), "其他");
  assert.equal(mapFundMainCategory(undefined), "其他");
  assert.equal(mapFundMainCategory(""), "其他");
  assert.equal(mapFundMainCategory("   "), "其他");
});

// 2026-11-11（上架前審查第6項根因修正，VERIFIED對照production全部funds.category不重複值）:
// 這6種實際存在、名稱明顯是股票/多重資產的分類，原本因為regex沒收錄落到「其他」，共226筆。
test("fixed regex gaps: equity/multi-asset categories that were wrongly falling to 其他", () => {
  assert.equal(mapFundMainCategory("World Small/Mid Stock"), "股票型基金");
  assert.equal(mapFundMainCategory("Europe Stock"), "股票型基金");
  assert.equal(mapFundMainCategory("China Region"), "股票型基金");
  assert.equal(mapFundMainCategory("Consumer Defensive"), "股票型基金");
  assert.equal(mapFundMainCategory("Infrastructure"), "股票型基金");
  assert.equal(mapFundMainCategory("跨國投資多重資產型"), "多重資產基金");
});

test("already-correct equity categories keep working after the regex change", () => {
  assert.equal(mapFundMainCategory("Large Blend"), "股票型基金");
  assert.equal(mapFundMainCategory("World Large Stock"), "股票型基金");
  assert.equal(mapFundMainCategory("Pacific/Asia ex-Japan Stk"), "股票型基金");
  assert.equal(mapFundMainCategory("Consumer Cyclical"), "股票型基金");
  assert.equal(mapFundMainCategory("股票型"), "股票型基金");
});

test("bond categories unaffected", () => {
  assert.equal(mapFundMainCategory("High Yield Bond"), "債券型基金");
  assert.equal(mapFundMainCategory("固定收益型"), "債券型基金");
});

test("multi-asset categories unaffected", () => {
  assert.equal(mapFundMainCategory("Allocation--50% to 70% Equity"), "多重資產基金");
  assert.equal(mapFundMainCategory("股票債券平衡型"), "多重資產基金");
});

// 2026-11-11: 商品型（Commodities Broad Basket等）、另類投資策略型（Multistrategy等）、
// Morningstar自己的miscellaneous——這4類分類本身在FundMainCategory沒有對應bucket（不像ETF側
// categoryClassification.ts有獨立COMMODITY bucket），維持誠實歸其他，不能亂塞進股票/債券/
// 多重資產三個不相關的bucket。
test("commodity/alternative-strategy/miscellaneous categories intentionally stay 其他 (no matching bucket exists)", () => {
  assert.equal(mapFundMainCategory("Commodities Broad Basket"), "其他");
  assert.equal(mapFundMainCategory("Equity Precious Metals"), "其他");
  assert.equal(mapFundMainCategory("Multistrategy"), "其他");
  assert.equal(mapFundMainCategory("Miscellaneous Sector"), "其他");
});
