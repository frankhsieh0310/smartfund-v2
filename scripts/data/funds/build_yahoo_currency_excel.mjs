import XLSX from "xlsx";
import fs from "fs";

const CUR_MAP = {
  "美元": "USD", "歐元": "EUR", "日圓": "JPY", "日幣": "JPY", "澳幣": "AUD", "南非幣": "ZAR",
  "人民幣": "CNY", "離岸人民幣": "CNY", "英鎊": "GBP", "加幣": "CAD", "加拿大幣": "CAD",
  "紐西蘭幣": "NZD", "港幣": "HKD", "新加坡幣": "SGD", "瑞士法郎": "CHF", "瑞典幣": "SEK",
  "挪威幣": "NOK", "新台幣": "TWD",
};

const DATA_PATH = "C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-tw-data-updater/1cb3a135-d2a6-4f7e-b9d2-604385fefaf2/scratchpad/yahoo_currency_chinese_rows.json";
const OUT_PATH = "C:/Users/User/Desktop/幣別中文字串清單_yahoo來源_20261021.xlsx"; // 新檔名，不覆蓋舊檔

const rows = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

const HEADERS = ["id", "代碼(code)", "ISIN", "基金名稱", "資料庫目前的中文幣別", "建議的ISO代碼", "data_provider", "是否在核心母體(網站/App會顯示)"];
const aoa = [HEADERS, ...rows.map((r) => [r.id, r.code, r.isin, r.name, r.db_currency_raw, CUR_MAP[r.db_currency_raw] ?? "無法對應", r.data_provider, r.in_core_universe ? "是" : "否"])];
const ws = XLSX.utils.aoa_to_sheet(aoa);
ws["!cols"] = [{ wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 46 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 18 }];
ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: HEADERS.length - 1 } }) };
ws["!freeze"] = { xSplit: 0, ySplit: 1 };

const byCurrency = {};
for (const r of rows) byCurrency[r.db_currency_raw] = (byCurrency[r.db_currency_raw] || 0) + 1;
const summaryAoa = [
  ["Yahoo來源幣別中文字串清單摘要（2026-10-21，唯讀分析）"],
  [],
  ["總筆數", rows.length],
  ["屬於核心母體（會顯示在網站/App）的筆數", rows.filter((r) => r.in_core_universe).length],
  [],
  ["中文幣別值", "筆數", "建議ISO代碼"],
  ...Object.entries(byCurrency).sort((a, b) => b[1] - a[1]).map(([cur, n]) => [cur, n, CUR_MAP[cur] ?? "無法對應（需人工確認）"]),
  [],
  ["備註：此清單純分析用，未對資料庫做任何修改。全部筆數均不在核心母體（tw_purchasable_classification.status='APPROVED'），所以不會出現在網站/App的基金列表或搜尋結果，只有直接用代碼/ID連結或先前已加入自選/比較的情況才會看到。"],
];
const wsSummary = XLSX.utils.aoa_to_sheet(summaryAoa);
wsSummary["!cols"] = [{ wch: 50 }, { wch: 14 }, { wch: 20 }];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, wsSummary, "摘要");
XLSX.utils.book_append_sheet(wb, ws, "明細");
XLSX.writeFile(wb, OUT_PATH);
console.log("saved:", OUT_PATH, "rows:", rows.length);
