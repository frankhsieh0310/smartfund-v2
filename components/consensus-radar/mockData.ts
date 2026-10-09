// 大佬雷達 V1 — UI-only mock dataset. No backend call, no real API.
//
// Identity note: names/orgs/titles below are REAL, recognizable public figures and institutions (per
// explicit product direction, for a believable V1 demo) — but every quote/direction/reason attached to
// them is entirely FICTIONAL, invented only to fill out the layout. This file (and every page built from
// it) must stay internal/localhost-only and carry a visible "模擬資料" disclaimer (see ui.tsx's
// <MockDisclaimer/>) for exactly this reason: these are not real statements by these real people.

export type Direction = "BULLISH" | "NEUTRAL" | "BEARISH";
export type PersonKind = "INDIVIDUAL" | "INSTITUTION";

export type Person = {
  id: string;
  nameZh: string;
  nameEn: string;
  org: string;
  title: string;
  kind: PersonKind;
};

export type Asset = {
  code: string;
  nameZh: string;
};

export type Opinion = {
  id: string;
  personId: string;
  assetCodes: string[];
  direction: Direction;
  reason: string;
  publishedAt: string; // ISO
  sourceLabel: string;
  isFlip: boolean; // 相對於本人上一次對同一標的的觀點，是否翻轉
};

export const PERSONS: Person[] = [
  { id: "p1", nameZh: "黃仁勳", nameEn: "Jensen Huang", org: "輝達 NVIDIA", title: "執行長", kind: "INDIVIDUAL" },
  { id: "p2", nameZh: "蘇姿丰", nameEn: "Lisa Su", org: "超微 AMD", title: "執行長", kind: "INDIVIDUAL" },
  { id: "p3", nameZh: "鮑威爾", nameEn: "Jerome Powell", org: "美國聯準會", title: "主席", kind: "INDIVIDUAL" },
  { id: "p4", nameZh: "凱西・伍德", nameEn: "Cathie Wood", org: "ARK Invest", title: "創辦人", kind: "INDIVIDUAL" },
  { id: "p5", nameZh: "霍華・馬克斯", nameEn: "Howard Marks", org: "橡樹資本", title: "共同創辦人", kind: "INDIVIDUAL" },
  { id: "p6", nameZh: "摩根士丹利研究團隊", nameEn: "Morgan Stanley Research", org: "摩根士丹利", title: "研究團隊", kind: "INSTITUTION" },
  { id: "p7", nameZh: "高盛研究團隊", nameEn: "Goldman Sachs Research", org: "高盛", title: "研究團隊", kind: "INSTITUTION" },
  { id: "p8", nameZh: "摩根大通研究團隊", nameEn: "J.P. Morgan Research", org: "摩根大通", title: "研究團隊", kind: "INSTITUTION" },
];

export const ASSETS: Asset[] = [
  { code: "2330", nameZh: "台積電" },
  { code: "2317", nameZh: "鴻海" },
  { code: "2454", nameZh: "聯發科" },
  { code: "2382", nameZh: "廣達" },
  { code: "5871", nameZh: "中租-KY" },
  { code: "3034", nameZh: "聯詠" },
];

export const FUND_HOLDERS: Record<string, string[]> = {
  "2330": ["元大台灣50(0050)", "國泰永續高股息(00878)", "某半導體產業基金"],
  "2317": ["元大台灣50(0050)", "某電子供應鏈主題基金"],
  "2454": ["元大台灣50(0050)", "某半導體產業基金", "某科技趨勢基金"],
  "2382": ["某電子供應鏈主題基金", "某AI主題基金"],
  "5871": ["國泰永續高股息(00878)", "某金融資產管理基金"],
  "3034": ["某半導體產業基金", "某科技趨勢基金"],
};

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

// Spread across the last ~7 days, mixing directions and a handful of explicit「翻轉」entries so every
// V1 section (今天誰改變看法 / 今天大家在看什麼 / 最新重要觀點 / 轉多轉空 / 時間軸) has real rows to
// render without needing any live data. Every `reason` here is invented for layout purposes only.
export const OPINIONS: Opinion[] = [
  { id: "o1", personId: "p1", assetCodes: ["2330"], direction: "BULLISH", reason: "先進製程與CoWoS封裝產能持續供不應求，看好下世代平台拉貨動能", publishedAt: hoursAgo(2), sourceLabel: "法人說明會紀要", isFlip: true },
  { id: "o2", personId: "p2", assetCodes: ["2454"], direction: "BEARISH", reason: "終端庫存調整速度不如預期，下修短期拉貨力道", publishedAt: hoursAgo(3), sourceLabel: "季度財報會議", isFlip: true },
  { id: "o3", personId: "p6", assetCodes: ["2317"], direction: "NEUTRAL", reason: "組裝業務毛利率仍待觀察下季表現，維持區間觀望", publishedAt: hoursAgo(5), sourceLabel: "摩根士丹利產業報告", isFlip: false },
  { id: "o4", personId: "p1", assetCodes: ["2454"], direction: "NEUTRAL", reason: "等待下季財報確認下游需求回溫力道", publishedAt: hoursAgo(6), sourceLabel: "媒體專訪", isFlip: false },
  { id: "o5", personId: "p4", assetCodes: ["2330"], direction: "BULLISH", reason: "海外新廠產能爬坡進度優於原訂計畫，長線訂單能見度提升", publishedAt: hoursAgo(8), sourceLabel: "季度投資展望", isFlip: false },
  { id: "o6", personId: "p5", assetCodes: ["5871"], direction: "BULLISH", reason: "租賃業務需求穩定、資產品質無虞，風險報酬比吸引", publishedAt: hoursAgo(10), sourceLabel: "橡樹資本備忘錄", isFlip: true },
  { id: "o7", personId: "p7", assetCodes: ["2330"], direction: "BULLISH", reason: "先進封裝產能持續供不應求，上修目標價", publishedAt: hoursAgo(12), sourceLabel: "高盛產業報告", isFlip: false },
  { id: "o8", personId: "p6", assetCodes: ["2382"], direction: "BULLISH", reason: "AI伺服器訂單挹注下半年營收動能，上修財測", publishedAt: hoursAgo(14), sourceLabel: "摩根士丹利產業報告", isFlip: false },
  { id: "o9", personId: "p8", assetCodes: ["3034"], direction: "NEUTRAL", reason: "客戶拉貨力道仍待第三季數據確認，維持區間觀望", publishedAt: hoursAgo(20), sourceLabel: "摩根大通產業報告", isFlip: false },
  { id: "o10", personId: "p2", assetCodes: ["2454"], direction: "BEARISH", reason: "庫存調整期可能延續至下季，看淡短期表現", publishedAt: hoursAgo(26), sourceLabel: "媒體專訪", isFlip: false },
  { id: "o11", personId: "p1", assetCodes: ["2330"], direction: "NEUTRAL", reason: "等待先進製程報價談判結果，暫不表態", publishedAt: hoursAgo(30), sourceLabel: "法人說明會紀要", isFlip: false },
  { id: "o12", personId: "p2", assetCodes: ["2454"], direction: "BULLISH", reason: "新產品線出貨進度順利，看好市占率提升", publishedAt: hoursAgo(34), sourceLabel: "季度財報會議", isFlip: false },
  { id: "o13", personId: "p6", assetCodes: ["2317"], direction: "NEUTRAL", reason: "持續追蹤組裝業務訂單能見度", publishedAt: hoursAgo(48), sourceLabel: "摩根士丹利產業報告", isFlip: false },
  { id: "o14", personId: "p4", assetCodes: ["2330"], direction: "BULLISH", reason: "資本支出規劃顯示長線需求樂觀，維持增持部位", publishedAt: hoursAgo(55), sourceLabel: "季度投資展望", isFlip: false },
  { id: "o15", personId: "p5", assetCodes: ["5871"], direction: "NEUTRAL", reason: "持續觀察資產品質變化，暫不加碼", publishedAt: hoursAgo(70), sourceLabel: "橡樹資本備忘錄", isFlip: false },
  { id: "o16", personId: "p7", assetCodes: ["2382"], direction: "BULLISH", reason: "AI相關訂單能見度持續拉長，維持首選名單", publishedAt: hoursAgo(96), sourceLabel: "高盛產業報告", isFlip: false },
  { id: "o17", personId: "p8", assetCodes: ["3034"], direction: "NEUTRAL", reason: "等待下游客戶訂單回溫訊號", publishedAt: hoursAgo(120), sourceLabel: "摩根大通產業報告", isFlip: false },
  { id: "o18", personId: "p6", assetCodes: ["2454"], direction: "BULLISH", reason: "新平台設計訂單陸續到位，上修評等", publishedAt: hoursAgo(144), sourceLabel: "摩根士丹利產業報告", isFlip: true },
  { id: "o19", personId: "p3", assetCodes: ["2330"], direction: "NEUTRAL", reason: "整體利率環境對資本支出循環影響仍待觀察", publishedAt: hoursAgo(18), sourceLabel: "公開談話紀要", isFlip: false },
];

export function getPerson(id: string): Person | undefined {
  return PERSONS.find((p) => p.id === id);
}
export function getAsset(code: string): Asset | undefined {
  return ASSETS.find((a) => a.code === code);
}
export function opinionsForPerson(personId: string): Opinion[] {
  return OPINIONS.filter((o) => o.personId === personId).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
export function opinionsForAsset(code: string): Opinion[] {
  return OPINIONS.filter((o) => o.assetCodes.includes(code)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
export function getOpinion(id: string): Opinion | undefined {
  return OPINIONS.find((o) => o.id === id);
}
// 同一人物對同一標的、在這筆觀點「之前」最近一筆的方向 — 觀點詳情頁「上次方向」用。
export function previousOpinionForSameAsset(opinion: Opinion): Opinion | undefined {
  const assetCode = opinion.assetCodes[0];
  return OPINIONS
    .filter((o) => o.personId === opinion.personId && o.assetCodes.includes(assetCode) && o.id !== opinion.id && o.publishedAt < opinion.publishedAt)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
}
export const DIRECTION_LABEL: Record<Direction, string> = { BULLISH: "偏多", NEUTRAL: "中性", BEARISH: "偏空" };
