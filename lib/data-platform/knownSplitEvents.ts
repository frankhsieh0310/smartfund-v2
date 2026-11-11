// 已知的ETF/股票分割、反分割事件清單——人工維護，因為Yahoo與TWSE/TPEx都沒有提供這類事件的
// 還原價資料集（2026-11-11驗證：0052 1拆7分割，Yahoo自己的adjclose在分割前後完全沒有把舊價
// 除以7，TWSE也查不到正式還原價資料集）。使用者核准（2026-11-11）：依官方公告的分割比例自己
// 換算分割前的歷史價格，畫面上標示「本App換算」。
//
// 新事件發生時要手動補進這份清單（來源：發行機構公告、TWSE/TPEx公告），不會自動偵測。
export type KnownSplitEvent = {
  assetType: "ETF" | "STOCK";
  code: string; // etfs.code 或 stocks.ticker
  effectiveDate: string; // 分割後第一個交易日；這天之前(exclusive)的歷史價格要除以 ratioOldToNew
  ratioOldToNew: number; // 例如 7 代表 1 拆 7：舊價 / 7 = 換算後價格
  note: string;
};

export const KNOWN_SPLIT_EVENTS: KnownSplitEvent[] = [
  {
    assetType: "ETF",
    code: "0052",
    effectiveDate: "2025-11-17",
    ratioOldToNew: 7,
    note: "0052富邦科技 1拆7單位分割（富邦投信公告，受益人會議98.78%同意通過）。Yahoo與TWSE均未提供此事件的還原價資料，本App依官方公告比例換算分割前歷史價格。",
  },
  // 2026-11-11 全面檢查時用日漲跌幅異常（>1.5x或<0.67x）掃出，WebSearch核實：iShares
  // 2026-10-05公告一批factor/產業ETF forward split，2026-11-05起以分割後股數交易。
  {
    assetType: "ETF",
    code: "MTUM",
    effectiveDate: "2026-11-05",
    ratioOldToNew: 4,
    note: "MTUM iShares MSCI USA Momentum Factor ETF 1拆4（iShares/BlackRock 2026-10-05公告，2026-11-05起分割後交易，確認來源：ishares.com產品頁）。本App依公告比例換算分割前歷史價格。",
  },
  {
    assetType: "ETF",
    code: "EFG",
    effectiveDate: "2026-11-05",
    ratioOldToNew: 3,
    note: "EFG iShares MSCI EAFE Growth ETF 1拆3（本資料庫觀測到2026-11-04→11-05比例0.34，與同批iShares factor ETF分割公告吻合，僅二次來源佐證，信心度中，建議人工再次核實）。本App依此比例換算分割前歷史價格。",
  },
];

export function splitAdjustmentFor(assetType: "ETF" | "STOCK", code: string, date: Date): { ratio: number; notes: string[] } {
  const events = KNOWN_SPLIT_EVENTS.filter(
    (e) => e.assetType === assetType && e.code === code && date.getTime() < new Date(e.effectiveDate).getTime(),
  );
  if (events.length === 0) return { ratio: 1, notes: [] };
  return { ratio: events.reduce((acc, e) => acc * e.ratioOldToNew, 1), notes: events.map((e) => e.note) };
}

export function hasAnyKnownSplit(assetType: "ETF" | "STOCK", code: string): boolean {
  return KNOWN_SPLIT_EVENTS.some((e) => e.assetType === assetType && e.code === code);
}
