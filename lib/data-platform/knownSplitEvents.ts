// 已知的ETF/股票分割、反分割事件清單——人工維護，因為Yahoo與TWSE/TPEx都沒有提供這類事件的
// 還原價資料集（2026-11-11驗證：0052 1拆7分割，Yahoo自己的adjclose在分割前後完全沒有把舊價
// 除以7，TWSE也查不到正式還原價資料集）。使用者核准（2026-11-11）：依官方公告的分割比例自己
// 換算分割前的歷史價格，畫面上標示「本App換算」。
//
// 新事件發生時要手動補進這份清單（來源：發行機構公告、TWSE/TPEx公告），不會自動偵測。
// 全面掃描方法（2026-11-11修正）: 用日漲跌幅異常抓可能的分割/反分割事件時，不要加
// ORDER BY date DESC搭配小LIMIT——同一天本身可能有上百筆槓桿型/每日型ETF的正常大幅波動
// （2X/3X單股槓桿ETF、Ultra/UltraShort基金），LIMIT還沒排到更早的日期就被這些正常雜訊佔滿，
// 導致QUAL/ITA/EFV這3檔（分割日在2026-11-03/11-04，比MTUM/EFG的11-05更早）第一輪完全沒掃到。
// 正確做法：撈出全部異常（不加LIMIT或給很大的LIMIT），依日期分組後用名稱關鍵字
// （2X/3X/Daily/Direxion/Tradr/Leveraged/Ultra/UltraShort/Inverse/Short/ETN/ETC等）先排除
// 已知的槓桿/每日型雜訊，剩下的再逐筆核實是否為真正的分割/反分割。
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
  // 2026-11-11（使用者核實並指定，第一輪掃描用ORDER BY date DESC LIMIT 60漏掉這3檔——同一天
  // 的日漲跌異常筆數遠超過60筆(2026-11-04/11-05那兩天本身就有數十筆槓桿型ETF正常波動)，LIMIT
  // 60在還沒排到2026-11-02/11-03就被吃完，掃描方法已修正見下方說明）。
  {
    assetType: "ETF",
    code: "QUAL",
    effectiveDate: "2026-11-03",
    ratioOldToNew: 4,
    note: "QUAL iShares MSCI USA Quality Factor ETF 1拆4（iShares/BlackRock同批factor ETF分割公告，2026-11-03起分割後交易，使用者核實）。本App依公告比例換算分割前歷史價格。",
  },
  {
    assetType: "ETF",
    code: "ITA",
    effectiveDate: "2026-11-04",
    ratioOldToNew: 3,
    note: "ITA iShares U.S. Aerospace & Defense ETF 1拆3（iShares/BlackRock同批產業ETF分割公告，2026-11-04起分割後交易，使用者核實）。本App依公告比例換算分割前歷史價格。",
  },
  {
    assetType: "ETF",
    code: "EFV",
    effectiveDate: "2026-11-03",
    ratioOldToNew: 2,
    note: "EFV iShares MSCI EAFE Value ETF 1拆2（iShares/BlackRock同批factor ETF分割公告，2026-11-03起分割後交易，使用者核實）。本App依公告比例換算分割前歷史價格。",
  },
  {
    assetType: "ETF",
    code: "SOXX",
    effectiveDate: "2026-11-03",
    ratioOldToNew: 3,
    note: "SOXX iShares Semiconductor ETF 1拆3（跟ITA同一批iShares產業ETF分割公告，2026-11-03起分割後交易，使用者核實，與台新銀行公告及多篇新聞一致）。本App依公告比例換算分割前歷史價格。",
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
