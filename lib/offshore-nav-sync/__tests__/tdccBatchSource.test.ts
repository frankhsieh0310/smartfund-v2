import assert from "node:assert/strict";
import { parseTdccNavCsv, parseTdccNavCsvRows, excludeOverlapWithYahooMapping, filterNewerThanStored, indexByCode, indexByCodeAcrossAgents, filterNewerThanStoredByCode, type TdccNavRow } from "../tdccBatchSource.ts";

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

// Task X8 (user-flagged design error, fixed): replaces the old `updated_at < 14 days ago` candidate
// filter -- writability is now decided purely by comparing the CSV's navDate against the fund's own
// stored latest_nav_date, never by how recently the fund was last written.
function navRow(navDate: string, nav = 100): TdccNavRow {
  return { code: "X", name: "測試基金", navDate, nav, isin: null, currency: null };
}

test("filterNewerThanStored: CSV date newer than stored latest_nav_date -> updates", () => {
  const byName = new Map([["測試基金", navRow("2026-10-14")]]);
  const result = filterNewerThanStored([{ id: "f1", name: "測試基金", latestNavDate: "2026-10-13", hasHistory: true }], byName);
  assert.deepEqual(result, [{ fundId: "f1", navDate: "2026-10-14", nav: 100 }]);
});

test("filterNewerThanStored: CSV date EQUAL to stored latest_nav_date -> skipped", () => {
  const byName = new Map([["測試基金", navRow("2026-10-13")]]);
  const result = filterNewerThanStored([{ id: "f1", name: "測試基金", latestNavDate: "2026-10-13", hasHistory: true }], byName);
  assert.deepEqual(result, []);
});

test("filterNewerThanStored: CSV date OLDER than stored latest_nav_date -> skipped", () => {
  const byName = new Map([["測試基金", navRow("2026-10-10")]]);
  const result = filterNewerThanStored([{ id: "f1", name: "測試基金", latestNavDate: "2026-10-13", hasHistory: true }], byName);
  assert.deepEqual(result, []);
});

test("filterNewerThanStored: fund never written before (latestNavDate=null) -> always updates regardless of CSV date", () => {
  const byName = new Map([["測試基金", navRow("2026-10-01")]]);
  const result = filterNewerThanStored([{ id: "f1", name: "測試基金", latestNavDate: null, hasHistory: false }], byName);
  assert.deepEqual(result, [{ fundId: "f1", navDate: "2026-10-01", nav: 100 }]);
});

test("filterNewerThanStored: two consecutive days both carry a new NAV -> both run's calls update", () => {
  // Simulates two separate daily invocations, not two rows in the same CSV (the CSV only ever
  // has one row per fund per run) -- day 1's write becomes day 2's "stored" baseline.
  const day1Csv = new Map([["測試基金", navRow("2026-10-13")]]);
  const day1Result = filterNewerThanStored([{ id: "f1", name: "測試基金", latestNavDate: "2026-10-12", hasHistory: true }], day1Csv);
  assert.deepEqual(day1Result, [{ fundId: "f1", navDate: "2026-10-13", nav: 100 }]);

  const day2Csv = new Map([["測試基金", navRow("2026-10-14")]]);
  const day2Result = filterNewerThanStored([{ id: "f1", name: "測試基金", latestNavDate: "2026-10-13", hasHistory: true }], day2Csv);
  assert.deepEqual(day2Result, [{ fundId: "f1", navDate: "2026-10-14", nav: 100 }]);
});

test("filterNewerThanStored: a fund with no CSV match at all is simply absent from the result, not an error", () => {
  const byName = new Map<string, TdccNavRow>();
  const result = filterNewerThanStored([{ id: "f1", name: "沒資料基金", latestNavDate: "2026-10-13", hasHistory: true }], byName);
  assert.deepEqual(result, []);
});

// 2026-11-02（VERIFIED，新上市基金NAV backfill卡住的根因修正）: CLOUD_NEW_FUND_LISTING_DETECTION
// 建檔時會直接種latest_nav_date，但不會寫fund_history——hasHistory=false時，即使CSV日期看起來
// 不比latestNavDate新，也要放行一次，讓fund_history真正補上。
test("filterNewerThanStored: latestNavDate seeded but no fund_history row yet (hasHistory=false) -> updates even when CSV date is NOT newer", () => {
  const byName = new Map([["新上市基金", navRow("2026-10-29")]]);
  const result = filterNewerThanStored([{ id: "f1", name: "新上市基金", latestNavDate: "2026-10-29", hasHistory: false }], byName);
  assert.deepEqual(result, [{ fundId: "f1", navDate: "2026-10-29", nav: 100 }]);
});

// This round's fix: data_provider='tdcc-offshore' funds (e.g. fund code "107") carry TDCC's own
// 基金代碼 directly in funds.code, so they're matched by code instead of name — the name-matching
// path above only ever applied to the data_provider='yahoo' population, which has no code at all.
test("indexByCode: builds a code -> row lookup from raw CSV rows, keeping the latest date per code", () => {
  const rows: TdccNavRow[] = [
    { code: "107", name: "富蘭克林公用事業基金美元A1股", navDate: "2026-10-12", nav: 23, isin: "US3534964099", currency: "USD" },
    { code: "107", name: "富蘭克林公用事業基金美元A1股", navDate: "2026-10-13", nav: 24, isin: "US3534964099", currency: "USD" },
  ];
  const byCode = indexByCode(rows);
  assert.equal(byCode.get("107")!.nav, 24);
});

// 2026-11-05（AXAWGRA根因回歸測試）：同一檔基金由兩個總代理各申報一筆、各用不同code，NAME完全
// 相同，但各自的最後更新日期不一樣（一個停在較舊日期，另一個持續更新到較新日期）。indexByCode()
// 若從byName（已依NAME去重、只留最新一筆）反推，較舊那個code會從byCode裡完全消失——即使CSV
// 原始資料裡那個code本身仍在持續申報。必須直接吃原始逐列資料，各code各自判斷最新日期。
test("indexByCode: two different codes sharing the SAME fund name (two 總代理) each keep their own latest date, not just the name-wide latest", () => {
  const rows: TdccNavRow[] = [
    { code: "AXAWGRA", name: "安盛環球基金-全球綜合債券基金A CAP歐元", navDate: "2026-10-29", nav: 28.35, isin: "LU0184633773", currency: "EUR" },
    { code: "AXAWGRA", name: "安盛環球基金-全球綜合債券基金A CAP歐元", navDate: "2026-10-30", nav: 28.42, isin: "LU0184633773", currency: "EUR" },
    { code: "LU0184633773", name: "安盛環球基金-全球綜合債券基金A CAP歐元", navDate: "2026-10-30", nav: 28.42, isin: "LU0184633773", currency: "EUR" },
    { code: "LU0184633773", name: "安盛環球基金-全球綜合債券基金A CAP歐元", navDate: "2026-11-03", nav: 28.39, isin: "LU0184633773", currency: "EUR" },
  ];
  const byCode = indexByCode(rows);
  // AXAWGRA's own latest row is still 10/30 -- it must NOT disappear just because the other code
  // (same name) has a newer row.
  assert.equal(byCode.get("AXAWGRA")!.navDate, "2026-10-30");
  assert.equal(byCode.get("AXAWGRA")!.nav, 28.42);
  assert.equal(byCode.get("LU0184633773")!.navDate, "2026-11-03");
  assert.equal(byCode.get("LU0184633773")!.nav, 28.39);
});

// 2026-11-05（使用者第二輪核准：換總代理不准歸類EXTERNAL_DELAY）：indexByCodeAcrossAgents()
// 以ISIN把同一檔基金的所有總代理code視為一組，一律取組內「淨值日期最新」那筆，無論我方
// funds.code綁定的是哪一個總代理。
test("indexByCodeAcrossAgents: two codes sharing the same ISIN (different 總代理) both resolve to the group's latest-dated row", () => {
  const rows: TdccNavRow[] = [
    { code: "AXAWGRA", name: "安盛環球基金-全球綜合債券基金A CAP歐元", navDate: "2026-10-30", nav: 28.42, isin: "LU0184633773", currency: "EUR" },
    { code: "LU0184633773", name: "安盛環球基金-全球綜合債券基金A CAP歐元", navDate: "2026-11-03", nav: 28.39, isin: "LU0184633773", currency: "EUR" },
  ];
  const byCode = indexByCodeAcrossAgents(rows);
  // Both codes -- including the one whose OWN latest row is older -- resolve to the newer row.
  assert.equal(byCode.get("AXAWGRA")!.navDate, "2026-11-03");
  assert.equal(byCode.get("AXAWGRA")!.nav, 28.39);
  assert.equal(byCode.get("LU0184633773")!.navDate, "2026-11-03");
  assert.equal(byCode.get("LU0184633773")!.nav, 28.39);
});

test("indexByCodeAcrossAgents: funds with no ISIN fall back to grouping by name+currency", () => {
  const rows: TdccNavRow[] = [
    { code: "C1", name: "無ISIN基金", navDate: "2026-10-30", nav: 10, isin: null, currency: "USD" },
    { code: "C2", name: "無ISIN基金", navDate: "2026-11-02", nav: 11, isin: null, currency: "USD" },
  ];
  const byCode = indexByCodeAcrossAgents(rows);
  assert.equal(byCode.get("C1")!.navDate, "2026-11-02");
  assert.equal(byCode.get("C2")!.navDate, "2026-11-02");
});

// 2026-11-05（抽查全部52檔時發現的真實危險案例，修正後才commit）：TDCC CSV裡有ISIN被重複使用
// 在「幣別不同的同一基金」(新加坡大華新加坡增長基金SGD/USD)、甚至「名稱完全不同的兩檔基金」
// (摩根士丹利歐洲機會基金 vs 歐洲冠軍基金)身上——單用ISIN分組會把這些誤併、用錯幣別的淨值覆蓋
// 另一個code，必須加上幣別一起當分組鍵才能避免。
test("indexByCodeAcrossAgents: same ISIN but DIFFERENT currency must NOT be merged (TDCC reuses ISIN across currency classes, even across unrelated funds)", () => {
  const rows: TdccNavRow[] = [
    { code: "USGFSG", name: "新加坡大華新加坡增長基金(星幣)", navDate: "2026-10-29", nav: 5.722, isin: "SG9999001127", currency: "SGD" },
    { code: "USGFUS", name: "新加坡大華新加坡增長基金(美元)", navDate: "2026-11-03", nav: 4.3378, isin: "SG9999001127", currency: "USD" },
  ];
  const byCode = indexByCodeAcrossAgents(rows);
  // USGFSG must keep its own SGD value -- must NOT be overwritten by USGFUS's USD value just
  // because USGFUS has a later date and they share an ISIN.
  assert.equal(byCode.get("USGFSG")!.nav, 5.722);
  assert.equal(byCode.get("USGFSG")!.currency, "SGD");
  assert.equal(byCode.get("USGFUS")!.nav, 4.3378);
});

test("indexByCodeAcrossAgents: different currencies with the same name are NOT merged (distinct funds/share classes)", () => {
  const rows: TdccNavRow[] = [
    { code: "C1", name: "同名不同幣別", navDate: "2026-10-30", nav: 10, isin: null, currency: "USD" },
    { code: "C2", name: "同名不同幣別", navDate: "2026-11-02", nav: 11, isin: null, currency: "EUR" },
  ];
  const byCode = indexByCodeAcrossAgents(rows);
  assert.equal(byCode.get("C1")!.navDate, "2026-10-30");
  assert.equal(byCode.get("C2")!.navDate, "2026-11-02");
});

test("parseTdccNavCsvRows: returns every valid row, not deduped by name (unlike parseTdccNavCsv)", () => {
  const csv = [
    "基金代碼,基金名稱,日期,基金淨值(金額),ISINCODE,計價幣別,境外基金機構,總代理機構",
    "AXAWGRA,同名基金,20261029,28.35,LU1,EUR,TestCo,AgentA",
    "AXAWGRA,同名基金,20261030,28.42,LU1,EUR,TestCo,AgentA",
    "LU1,同名基金,20261103,28.39,LU1,EUR,TestCo,AgentB",
  ].join("\n");
  const rows = parseTdccNavCsvRows(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.code), ["AXAWGRA", "AXAWGRA", "LU1"]);
});

test("filterNewerThanStoredByCode: matches by code, same forward-only-date rule as the name path", () => {
  const byCode = new Map([["107", navRow("2026-10-13", 24)]]);
  const result = filterNewerThanStoredByCode([{ id: "fund-107", code: "107", latestNavDate: null, hasHistory: false }], byCode);
  assert.deepEqual(result, [{ fundId: "fund-107", navDate: "2026-10-13", nav: 24 }]);
});

test("filterNewerThanStoredByCode: never writes TDCC's own -9999 sentinel even if it somehow reaches this far", () => {
  const byCode = new Map([["XYZ", { code: "XYZ", name: "測試", navDate: "2026-10-13", nav: -9999, isin: null, currency: null } as TdccNavRow]]);
  const result = filterNewerThanStoredByCode([{ id: "fund-x", code: "XYZ", latestNavDate: null, hasHistory: false }], byCode);
  assert.deepEqual(result, []);
});

test("filterNewerThanStoredByCode: a code with no CSV match at all is simply absent, not an error", () => {
  const byCode = new Map<string, TdccNavRow>();
  const result = filterNewerThanStoredByCode([{ id: "fund-x", code: "NOPE", latestNavDate: null, hasHistory: false }], byCode);
  assert.deepEqual(result, []);
});

test("filterNewerThanStoredByCode: latestNavDate seeded but no fund_history row yet (hasHistory=false) -> updates even when CSV date is NOT newer", () => {
  const byCode = new Map([["107", navRow("2026-10-29", 24)]]);
  const result = filterNewerThanStoredByCode([{ id: "fund-107", code: "107", latestNavDate: "2026-10-29", hasHistory: false }], byCode);
  assert.deepEqual(result, [{ fundId: "fund-107", navDate: "2026-10-29", nav: 24 }]);
});
