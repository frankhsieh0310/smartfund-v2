import assert from "node:assert/strict";
import { parseTdccNavCsv, excludeOverlapWithYahooMapping } from "../tdccBatchSource.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test("parseTdccNavCsv: rejects a -9999 sentinel row and falls back to the fund's last genuinely-positive row, keeping THAT row's own date", () => {
  const csv = [
    "基金代碼,基金名稱,日期,基金淨值(金額),ISINCODE,計價幣別,境外基金機構,總代理機構",
    "ABC123,測試基金A,20261007,23.187000,LU0000000001,EUR,TestCo,TestAgent",
    "ABC123,測試基金A,20261009,23.216300,LU0000000001,EUR,TestCo,TestAgent",
    "ABC123,測試基金A,20261012,-9999.000000,LU0000000001,EUR,TestCo,TestAgent",
  ].join("\n");
  const byName = parseTdccNavCsv(csv);
  const row = byName.get("測試基金A");
  assert.ok(row, "fund must still be present despite its latest row being the sentinel");
  // Must NOT be today's date, and must NOT be the sentinel's own date (2026-10-12) -- it must be the
  // date of the last row that actually had a positive nav (2026-10-09).
  assert.equal(row!.navDate, "2026-10-09");
  assert.equal(row!.nav, 23.2163);
});

test("parseTdccNavCsv: a fund with ONLY sentinel rows is dropped entirely, not written with a fabricated date/value", () => {
  const csv = [
    "基金代碼,基金名稱,日期,基金淨值(金額),ISINCODE,計價幣別,境外基金機構,總代理機構",
    "XYZ999,全部無效基金,20261007,-9999.000000,LU0000000002,USD,TestCo,TestAgent",
    "XYZ999,全部無效基金,20261012,-9999.000000,LU0000000002,USD,TestCo,TestAgent",
  ].join("\n");
  const byName = parseTdccNavCsv(csv);
  assert.equal(byName.has("全部無效基金"), false);
});

test("parseTdccNavCsv: normal rows pick the LATEST date, unaffected by sentinel-filtering logic", () => {
  const csv = [
    "基金代碼,基金名稱,日期,基金淨值(金額),ISINCODE,計價幣別,境外基金機構,總代理機構",
    "DEF456,正常基金,20261007,10.0000,LU0000000003,USD,TestCo,TestAgent",
    "DEF456,正常基金,20261012,10.5000,LU0000000003,USD,TestCo,TestAgent",
  ].join("\n");
  const byName = parseTdccNavCsv(csv);
  const row = byName.get("正常基金");
  assert.equal(row!.navDate, "2026-10-12");
  assert.equal(row!.nav, 10.5);
});

test("excludeOverlapWithYahooMapping: drops every fund already in offshore-nav-sync's own Yahoo mapping", () => {
  const candidates = [{ id: "fund-1", name: "A" }, { id: "fund-2", name: "B" }, { id: "fund-3", name: "C" }];
  const result = excludeOverlapWithYahooMapping(candidates, ["fund-2"]);
  assert.deepEqual(result.map((f) => f.id), ["fund-1", "fund-3"]);
});

test("excludeOverlapWithYahooMapping: empty mapping excludes nothing", () => {
  const candidates = [{ id: "fund-1", name: "A" }];
  const result = excludeOverlapWithYahooMapping(candidates, []);
  assert.deepEqual(result, candidates);
});
