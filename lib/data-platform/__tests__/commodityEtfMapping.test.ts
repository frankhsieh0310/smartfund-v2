import assert from "node:assert/strict";
import { etfsForCommodity, COMMODITY_ETF_MAPPING } from "../commodityEtfMapping.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("GOLD returns exactly the 3 gold ETFs (long/inverse/2x)", () => {
  const gold = etfsForCommodity("GOLD");
  assert.equal(gold.length, 3);
  assert.deepEqual(gold.map((e) => e.code).sort(), ["00635U", "00674R", "00708L"]);
});

test("every mapping entry has a unique code (no accidental duplicate rows)", () => {
  const codes = COMMODITY_ETF_MAPPING.map((e) => e.code);
  assert.equal(new Set(codes).size, codes.length);
});

test("WTI_CRUDE and BRENT_CRUDE stay separate (different underlying benchmarks, never merged)", () => {
  assert.equal(etfsForCommodity("WTI_CRUDE").some((e) => e.code === "00715L"), false);
  assert.equal(etfsForCommodity("BRENT_CRUDE").some((e) => e.code === "00715L"), true);
});
