import assert from "node:assert/strict";
import { extractAvailableMonths, parseResultTable } from "../sitcaDividendFetch.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("extractAvailableMonths: parses YYYYMM option values, deduped", () => {
  const html = `<option value="202206">2022 年 06 月</option><option value="202207">2022 年 07 月</option><option value="202206">dup</option>`;
  assert.deepEqual(extractAvailableMonths(html), ["202206", "202207"]);
});

const SAMPLE_TABLE_HTML = `
<div>...</div>
<td colspan="2" align="center">
<table><tr><td class=DTHeader nowrap align=center>基金類型</th><td class=DTHeader nowrap align=center>基金統編</th><td class=DTHeader nowrap align=center>基金名稱</th><td class=DTHeader nowrap align=center>配息幣別</th><td class=DTHeader nowrap align=center>配息基準日</th><td class=DTHeader nowrap align=center>除息日</th><td class=DTHeader nowrap align=center>收益分<br>配發放日</th><td class=DTHeader nowrap align=center>每單位<br>分派金額</th></tr><tr><td class='DTeven' align=left>AH22</td><td class='DTeven' align=left>00512527</td><td class='DTeven' align=left>兆豐美國企業優選投資級公司債ETF基金</td><td class='DTeven' align=left>TWD</td><td class='DTeven' align=left>20260824</td><td class='DTeven' align=left>20260818</td><td class='DTeven' align=left>20260904</td><td class='DTeven' align=right>0.06200</td></tr></table>
`;

test("parseResultTable: parses a real-shape row correctly", () => {
  const rows = parseResultTable(SAMPLE_TABLE_HTML);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    fundType: "AH22", taxId: "00512527", fundName: "兆豐美國企業優選投資級公司債ETF基金",
    currency: "TWD", baseDate: "2026-08-24", exDate: "2026-08-18", payDate: "2026-09-04", amount: 0.062,
  });
});

test("parseResultTable: no DTHeader anywhere -> empty (month not yet published)", () => {
  assert.deepEqual(parseResultTable("<html><body>no data</body></html>"), []);
});

test("parseResultTable: zero/negative amount rows are dropped", () => {
  const html = SAMPLE_TABLE_HTML.replace("0.06200", "0");
  assert.deepEqual(parseResultTable(html), []);
});
