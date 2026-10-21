// TDCC dataset 3-2（計價幣別）中文名稱 -> ISO 4217 代碼的唯一對照表。
// 2026-10-21 新增「日幣」「加幣」：原始對照表誤用「日圓」「加拿大幣」這兩個同義詞當 key，
// 但 TDCC 官方資料實際寫的是「日幣」「加幣」，導致這兩種幣別的76+3檔被誤判為「找不到對應」
// 而原樣寫入中文字串到 funds.currency。同時保留常見同義詞，避免未來官方資料用詞微調又漏掉。
// 來源驗證：2026-10-21 用 https://opendata.tdcc.com.tw/getOD.ashx?id=3-2 即時資料核對，
// 該日實際出現的12種幣別（加幣、南非幣、新加坡幣、日幣、歐元、港幣、澳幣、瑞典幣、
// 瑞士法郎、紐西蘭幣、美元、英鎊）全部都有對應。
export const TDCC_CURRENCY_MAP: Record<string, string> = {
  "美元": "USD",
  "歐元": "EUR",
  "日幣": "JPY",
  "日圓": "JPY", // 同義詞，官方資料未必統一用字
  "澳幣": "AUD",
  "南非幣": "ZAR",
  "人民幣": "CNY",
  "離岸人民幣": "CNY",
  "英鎊": "GBP",
  "加幣": "CAD",
  "加拿大幣": "CAD", // 同義詞
  "紐西蘭幣": "NZD",
  "港幣": "HKD",
  "新加坡幣": "SGD",
  "瑞士法郎": "CHF",
  "瑞典幣": "SEK",
  "挪威幣": "NOK",
  "新台幣": "TWD",
};

/** 回傳 ISO 代碼；查不到時回傳 null（呼叫端必須把 null 視為「需人工確認」，絕不原樣寫入中文）。 */
export function mapTdccCurrencyToIso(raw: string): string | null {
  return TDCC_CURRENCY_MAP[raw.trim()] ?? null;
}
