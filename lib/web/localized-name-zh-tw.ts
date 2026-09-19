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
};

export const localizedNameZhTw = (symbol: string | null | undefined, fallback: string) => {
  const entry = symbol ? NAMES[symbol.toUpperCase()] : undefined;
  if (entry && entry.confidence !== "UNVERIFIED") return entry.name;
  const rawLocalScript = /[\u3040-\u30ff\uac00-\ud7af]/u.test(fallback);
  const simplifiedOnly = /[这为发国东业产价众优会体关务动区华协历县台号后听员实对导届属币应总战户执据数时条来标样档检气汇汉济测点炼现电确类约级统线经绩联获营证设资软过进选长门问际项题]/u.test(fallback);
  return rawLocalScript || simplifiedOnly ? symbol ?? "名稱待確認" : fallback;
};
export const LOCALIZED_NAME_ZH_TW_COUNT = Object.keys(NAMES).length;
export const UNVERIFIED_LOCALIZED_NAME_COUNT = Object.values(NAMES).filter((entry) => entry.confidence === "UNVERIFIED").length;
