// Yuanta's own official 追蹤差距 (tracking difference) page — copied verbatim, not self-calculated,
// per CLAUDE.md's "有官方現成數字就照抄" rule. Same site/technique as yuanta.ts's holdings adapter
// (window.__NUXT__ state payload, plain HTTP, no headless browser, no bot protection).
//
// VERIFIED 2026-10-29: https://www.yuantaetfs.com/tradeInfo/trackingDifference/ETF embeds
// state.data[0].allData, ~220 rows, one pair of rows per fund (type "F") sharing a `fund_id` with
// its reference index row (type "I"). Both rows in a pair carry the SAME `deviation` (daily, %) and
// `lsdeviation` (cumulative since last ROC-year-end, %) values and the same `daydate` — e.g. 0050
// (fund_id 1066, VERIFIED 2026-10-28 snapshot): deviation 0.01, lsdeviation -1.48.
//
// Matching is by ETF CODE, never by Chinese name (per explicit instruction): this module maps
// fund_id -> ETF code via a small hand-verified table (TRACKED_YUANTA_FUND_IDS below), not fuzzy
// name matching — the same mistake that left global_index_benchmark_resolution_queue stuck at 0/223.
const BASE = "https://www.yuantaetfs.com";

type RawRow = { fund_id: string; type: "I" | "F" | "S"; name: string; deviation: number; lsdeviation: number; daydate: string };

export type YuantaTrackingDifference = { deviation: number; lsdeviation: number; asOfDate: string; indexName: string };

// VERIFIED: this page's own daydate field is already a plain Gregorian YYYYMMDD string (e.g.
// "20261028"), unlike TAI50I/MFI94U's ROC-year dates elsewhere in this codebase — no +1911
// conversion here, just reformatting.
function gregorianYmdToIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function extractNuxtState(html: string): any {
  const m = html.match(/<script>window\.__NUXT__=([\s\S]*?)<\/script>/);
  if (!m) throw new Error("YUANTA_TD_NO_NUXT_STATE — page markup changed, adapter needs re-verification");
  return new Function(`return ${m[1]}`)();
}

/** Returns, for every fund_id present on the page, its tracking-difference figures plus the paired
 * index row's name (so callers can log/verify which index each number was compared against). */
export async function fetchAllYuantaTrackingDifferences(): Promise<Map<string, YuantaTrackingDifference>> {
  const res = await fetch(`${BASE}/tradeInfo/trackingDifference/ETF`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`YUANTA_TD_HTTP_${res.status}`);
  const html = await res.text();
  const state = extractNuxtState(html);
  const allData: RawRow[] = state?.data?.[0]?.allData ?? [];
  if (!allData.length) throw new Error("YUANTA_TD_NO_ALLDATA — __NUXT__ state present but data[0].allData missing/empty");

  const byFundId = new Map<string, { fundRow?: RawRow; indexRow?: RawRow }>();
  for (const row of allData) {
    const entry = byFundId.get(row.fund_id) ?? {};
    if (row.type === "F") entry.fundRow = row;
    else if (row.type === "I") entry.indexRow = row;
    byFundId.set(row.fund_id, entry);
  }

  const result = new Map<string, YuantaTrackingDifference>();
  for (const [fundId, { fundRow, indexRow }] of byFundId) {
    if (!fundRow || !indexRow) continue;
    result.set(fundId, { deviation: fundRow.deviation, lsdeviation: fundRow.lsdeviation, asOfDate: gregorianYmdToIso(fundRow.daydate), indexName: indexRow.name });
  }
  return result;
}

// 2026-10-29（VERIFIED，手動核對每一筆fund_id對應哪一檔ETF代碼——不用中文名稱比對）: 從
// https://www.yuantaetfs.com/tradeInfo/trackingDifference/ETF 的allData裡，對規模前50大台股ETF
// 中屬於元大發行的逐一核對fund_id。只收錄已核對過的，其餘元大ETF或非元大發行的ETF不在這份對照表
// 裡，不會顯示錯誤配對的數字。
export const TRACKED_YUANTA_FUND_IDS: Record<string, string> = {
  "1066": "0050", // 元大台灣卓越50基金 / 臺灣50指數
  "1084": "0056", // 元大台灣高股息基金 / 臺灣高股息指數
  "1164": "00713", // 元大台灣高股息低波動ETF基金 / 特選高股息低波動指數
  "1116": "00631L", // 元大台灣50單日正向2倍基金 / 臺灣50單日正向2倍報酬指數
  "1198": "00850", // 元大臺灣ESG永續ETF基金 / 臺灣永續指數
};
