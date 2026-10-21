import XLSX from "xlsx";
import fs from "fs";

const DATA_PATH = "C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-tw-data-updater/1cb3a135-d2a6-4f7e-b9d2-604385fefaf2/scratchpad/currency_export_data.json";
const OUT_PATH = "C:/Users/User/Desktop/幣別比對清單_20261021.xlsx";

const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

const HEADERS = [
  "基金代碼", "基金完整名稱（資料庫）", "基金完整名稱（官方資料）",
  "資料庫目前的幣別", "官方資料的幣別（原文）", "準備改成的ISO代碼",
  "官方資料來源與資料日期", "是否為避險級別", "名稱中是否出現多個幣別", "信心程度",
];
const KEYS = ["code", "dbName", "officialName", "dbCurrency", "officialCurrencyRaw", "isoCode", "source", "hedged", "multiCurrency", "confidence"];
const COL_WIDTHS = [16, 42, 42, 12, 14, 12, 26, 12, 14, 14];

function sortRows(rows) {
  // 需人工確認排前面，方便優先查看
  return [...rows].sort((a, b) => (a.confidence === "需人工確認" ? 0 : 1) - (b.confidence === "需人工確認" ? 0 : 1));
}

function buildSheet(rows) {
  const sorted = sortRows(rows);
  const aoa = [HEADERS, ...sorted.map((r) => KEYS.map((k) => r[k]))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = COL_WIDTHS.map((w) => ({ wch: w }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sorted.length, c: HEADERS.length - 1 } }) };
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  // Header row bold via cell style (best-effort; community xlsx has limited style support)
  for (let c = 0; c < HEADERS.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1F4E78" } } };
  }
  return ws;
}

const tdccRows = data.tdccRows;
const sitcaRows = data.sitcaRows;
const tdccN = tdccRows.length, sitcaN = sitcaRows.length;

const wb = XLSX.utils.book_new();

const wsTdcc = buildSheet(tdccRows);
XLSX.utils.book_append_sheet(wb, wsTdcc, "境外基金 TDCC");
const wsSitca = buildSheet(sitcaRows);
XLSX.utils.book_append_sheet(wb, wsSitca, "境內基金 SITCA");

// ---- Summary sheet ----
const allIsos = [...new Set([...tdccRows, ...sitcaRows].map((r) => r.isoCode))].sort();
const summaryAoa = [
  ["幣別比對清單摘要（2026-10-21）"],
  [],
  ["資料來源", "工作表", "不一致筆數"],
  ["TDCC dataset 3-2（境外基金）", "境外基金 TDCC", tdccN],
  ["SITCA CSV（境內基金）", "境內基金 SITCA", sitcaN],
  ["總計", "", { t: "n", f: "SUM(C4:C5)" }],
  [],
  ["準備改成的ISO代碼（合併兩表）"],
  ["ISO代碼", "檔數"],
];
for (const iso of allIsos) {
  const rowIdx = summaryAoa.length; // 0-based row index this entry will occupy
  const rowNum1 = rowIdx + 1; // 1-based row number for formula self-reference
  summaryAoa.push([
    iso,
    { t: "n", f: `COUNTIF('境外基金 TDCC'!F2:F${tdccN + 1},A${rowNum1})+COUNTIF('境內基金 SITCA'!F2:F${sitcaN + 1},A${rowNum1})` },
  ]);
}
summaryAoa.push([]);
summaryAoa.push(["需人工確認的檔數（合併兩表）", "", { t: "n", f: `COUNTIF('境外基金 TDCC'!J2:J${tdccN + 1},"需人工確認")+COUNTIF('境內基金 SITCA'!J2:J${sitcaN + 1},"需人工確認")` }]);
summaryAoa.push(["官方幣別為新台幣的檔數（合併兩表）", "", { t: "n", f: `COUNTIF('境外基金 TDCC'!F2:F${tdccN + 1},"TWD")+COUNTIF('境內基金 SITCA'!F2:F${sitcaN + 1},"TWD")` }]);
summaryAoa.push([]);
summaryAoa.push(["備註：每個工作表內「需人工確認」的列已排到最上方，方便優先查看（避險級別、名稱含多種幣別、官方標示新台幣但名稱有外幣字樣，或名稱比對不完全一致）。"]);

const wsSummary = XLSX.utils.aoa_to_sheet(summaryAoa);
wsSummary["!cols"] = [{ wch: 36 }, { wch: 20 }, { wch: 16 }];
wsSummary["A1"].s = { font: { bold: true, sz: 14 } };
if (wsSummary["A3"]) wsSummary["A3"].s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1F4E78" } } };
if (wsSummary["B3"]) wsSummary["B3"].s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1F4E78" } } };
if (wsSummary["C3"]) wsSummary["C3"].s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1F4E78" } } };

// Move "摘要" to be the first sheet
XLSX.utils.book_append_sheet(wb, wsSummary, "摘要");
wb.SheetNames = ["摘要", "境外基金 TDCC", "境內基金 SITCA"];

XLSX.writeFile(wb, OUT_PATH, { cellStyles: true });
console.log("saved:", OUT_PATH);
console.log("TDCC rows:", tdccN, "SITCA rows:", sitcaN, "total:", tdccN + sitcaN);

const confirmTdcc = tdccRows.filter((r) => r.confidence === "需人工確認").length;
const confirmSitca = sitcaRows.filter((r) => r.confidence === "需人工確認").length;
console.log("需人工確認 TDCC:", confirmTdcc, "SITCA:", confirmSitca, "合計:", confirmTdcc + confirmSitca);
const twdOfficialTdcc = tdccRows.filter((r) => r.isoCode === "TWD").length;
const twdOfficialSitca = sitcaRows.filter((r) => r.isoCode === "TWD").length;
console.log("官方幣別為TWD TDCC:", twdOfficialTdcc, "SITCA:", twdOfficialSitca, "合計:", twdOfficialTdcc + twdOfficialSitca);
