import assert from "node:assert/strict";
import { matchDividendRows } from "../matching.ts";
import type { SitcaDividendRow, FundRow } from "../types.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const row = (overrides: Partial<SitcaDividendRow> = {}): SitcaDividendRow => ({
  fundType: "AA1", taxId: "00512527", fundName: "測試基金", currency: "TWD",
  baseDate: "2026-08-24", exDate: "2026-08-18", payDate: "2026-09-04", amount: 0.1,
  ...overrides,
});

test("matchDividendRows: matches by code first", () => {
  const funds: FundRow[] = [{ id: "f1", code: "00512527", name: "不同名字", currency: "TWD" }];
  const { matched, unmatched } = matchDividendRows([row()], funds);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].matchedBy, "CODE");
  assert.equal(unmatched.length, 0);
});

test("matchDividendRows: falls back to normalized name when code doesn't match", () => {
  const funds: FundRow[] = [{ id: "f1", code: "99999999", name: "測試基金", currency: "TWD" }];
  const { matched } = matchDividendRows([row({ taxId: "00000000" })], funds);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].matchedBy, "NAME");
});

test("matchDividendRows: no code match + ambiguous name match -> unmatched", () => {
  const funds: FundRow[] = [
    { id: "f1", code: "11111111", name: "測試基金", currency: "TWD" },
    { id: "f2", code: "22222222", name: "測試基金", currency: "TWD" },
  ];
  const { matched, unmatched } = matchDividendRows([row({ taxId: "00000000" })], funds);
  assert.equal(matched.length, 0);
  assert.equal(unmatched.length, 1);
});

test("matchDividendRows: carries sitcaCurrency/fundCurrency through for the caller's currency gate", () => {
  const funds: FundRow[] = [{ id: "f1", code: "00512527", name: "x", currency: "USD" }];
  const { matched } = matchDividendRows([row({ currency: "TWD" })], funds);
  assert.equal(matched[0].sitcaCurrency, "TWD");
  assert.equal(matched[0].fundCurrency, "USD");
});
