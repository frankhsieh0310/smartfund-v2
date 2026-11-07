export type LocalizedNameConfidence = "OFFICIAL" | "TAIWAN_COMMON" | "VERIFIED_TRANSLITERATION" | "UNVERIFIED";
type Entry = { name: string; confidence: LocalizedNameConfidence };

const NAMES: Record<string, Entry> = {
  "7203.T": { name: "豐田汽車", confidence: "TAIWAN_COMMON" },
  "005930.KS": { name: "三星電子", confidence: "TAIWAN_COMMON" },
  "012330.KS": { name: "現代摩比斯", confidence: "TAIWAN_COMMON" },
  "7974.T": { name: "任天堂", confidence: "TAIWAN_COMMON" },
  "6758.T": { name: "索尼集團", confidence: "TAIWAN_COMMON" },
  "8306.T": { name: "三菱日聯金融集團", confidence: "TAIWAN_COMMON" },
  "000660.KS": { name: "SK海力士", confidence: "TAIWAN_COMMON" },
  "8035.T": { name: "東京威力科創", confidence: "TAIWAN_COMMON" },
  "2330.TW": { name: "台積電", confidence: "TAIWAN_COMMON" },
  // TSM is the NYSE ADR for the same company as 2330.TW — real, verified common name, not an AI
  // translation. Confirmed via DB: stocks.company_name_zh is NULL for the TSM row (only company_name,
  // English), so without this entry the ADR falls through to its English legal name.
  "TSM": { name: "台積電", confidence: "TAIWAN_COMMON" },
};

export const localizedNameZhTw = (symbol: string | null | undefined, fallback: string) => {
  const entry = symbol ? NAMES[symbol.toUpperCase()] : undefined;
  if (entry && entry.confidence !== "UNVERIFIED") return entry.name;
  const rawLocalScript = /[\u3040-\u30ff\uac00-\ud7af]/u.test(fallback);
  // 2026-11-08（VERIFIED，使用者回報搜尋頁名稱顯示成代碼的根因修正）: 這個字元表原本含「台」——
  // 但「台」本身就是台灣慣用的正體字（「台灣」「新台幣」「台北」都正常使用「台」，不是「臺」的
  // 簡體字），不是簡體字的專屬標記。VERIFIED：國泰小龍基金-新台幣A/R這兩個正體中文基金名稱因為
  // 含「新台幣」被這條規則誤判成簡體字，搜尋結果改顯示代碼(01031874A)而不是真正的基金名稱——
  // 這支App/網站全站只有searchService.ts（搜尋頁/App的/api/search）用這個函式，基金清單、排行、
  // 反查、自選都直接顯示funds.name本身，不受影響。拿掉「台」，不動其餘字元。
  const simplifiedOnly = /[这为发国东业产价众优会体关务动区华协历县号后听员实对导届属币应总战户执据数时条来标样档检气汇汉济测点炼现电确类约级统线经绩联获营证设资软过进选长门问际项题]/u.test(fallback);
  return rawLocalScript || simplifiedOnly ? symbol ?? "名稱待確認" : fallback;
};
export const LOCALIZED_NAME_ZH_TW_COUNT = Object.keys(NAMES).length;
export const UNVERIFIED_LOCALIZED_NAME_COUNT = Object.values(NAMES).filter((entry) => entry.confidence === "UNVERIFIED").length;
