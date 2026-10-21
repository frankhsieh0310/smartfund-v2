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

// 2026-10-21（使用者核准，不能只檢查三個大寫字母）: 正式的 ISO 4217 現行流通貨幣代碼清單
// （不含已停用/歷史代碼），所有「這個字串是不是合法幣別代碼」的檢查都要用這份共用清單，不能
// 只驗證格式（三碼大寫字母）——"XYZ" 這種格式正確但根本不是貨幣的字串必須被當成無效。
export const ISO_4217_CURRENCY_CODES: ReadonlySet<string> = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SYP", "SZL", "THB", "TJS",
  "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD",
  "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF",
  "YER", "ZAR", "ZMW", "ZWL",
]);

/** 嚴格ISO 4217驗證：格式(三碼大寫)對了還不夠，必須在正式現行流通貨幣代碼清單裡，"XYZ"這種
 * 查無此幣別的字串一律視為無效。所有寫入路徑跟健康檢查都用這一份，不能各自寫一套格式檢查。 */
export function isValidIsoCurrency(value: string | null | undefined): value is string {
  return !!value && ISO_4217_CURRENCY_CODES.has(value);
}
