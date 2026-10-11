import assert from "node:assert/strict";
import { matchSitcaRows, nfkcNameKey } from "../matching.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
  return p;
}

(async () => {
  test("nfkcNameKey: strips whitespace, normalizes 臺->台, lowercases", () => {
    assert.equal(nfkcNameKey("兆豐 ESG臺美 基金"), nfkcNameKey("兆豐ESG台美基金"));
  });

  test("matchSitcaRows: exact code match wins even if names differ slightly", () => {
    const rows = [{ taxId: "00526748A", name: "兆豐ESG台美基金(新台幣)-累積型", nav: 13.8, navDate: "2026-10-07" }];
    const funds = [{ id: "f1", code: "00526748A", name: "兆豐ESG台美基金 (新台幣) 累積型" }]; // slightly different formatting
    const { matched, unmatched } = matchSitcaRows(rows, funds);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].matchedBy, "CODE");
    assert.equal(matched[0].fundId, "f1");
    assert.equal(unmatched.length, 0);
  });

  test("matchSitcaRows: falls back to name match when code doesn't match", () => {
    const rows = [{ taxId: "NO_SUCH_CODE", name: "瀚亞巴西基金", nav: 8.46, navDate: "2026-10-07" }];
    const funds = [{ id: "f2", code: "DIFFERENT_CODE", name: "瀚亞巴西基金" }];
    const { matched, unmatched } = matchSitcaRows(rows, funds);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].matchedBy, "NAME");
    assert.equal(unmatched.length, 0);
  });

  test("matchSitcaRows: no match at all when neither code nor name matches", () => {
    const rows = [{ taxId: "X", name: "完全不存在的基金", nav: 1, navDate: "2026-10-07" }];
    const funds = [{ id: "f3", code: "Y", name: "另一檔基金" }];
    const { matched, unmatched } = matchSitcaRows(rows, funds);
    assert.equal(matched.length, 0);
    assert.equal(unmatched.length, 1);
  });

  test("matchSitcaRows: an ambiguous (multi-fund) name match is rejected, never guessed", () => {
    const rows = [{ taxId: "NO_CODE", name: "同名基金", nav: 1, navDate: "2026-10-07" }];
    const funds = [{ id: "f4", code: "A", name: "同名基金" }, { id: "f5", code: "B", name: "同名基金" }];
    const { matched, unmatched } = matchSitcaRows(rows, funds);
    assert.equal(matched.length, 0);
    assert.equal(unmatched.length, 1);
  });

  test("matchSitcaRows: never invents a fund — unmatched rows are reported, not created", () => {
    const rows = [
      { taxId: "A", name: "一", nav: 1, navDate: "2026-10-07" },
      { taxId: "B", name: "二", nav: 2, navDate: "2026-10-07" },
    ];
    const { matched, unmatched } = matchSitcaRows(rows, []);
    assert.equal(matched.length, 0);
    assert.equal(unmatched.length, 2);
  });
})();
