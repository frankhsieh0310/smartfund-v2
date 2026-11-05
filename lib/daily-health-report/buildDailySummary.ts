// 2026-11-05（使用者核准，Telegram推送第二版——取代第一版的「摘要+即時推送」兩則訊息設計）：
// 健康報告一天只跑一次，原本「每日摘要」跟「即時推送」會同時送出、內容重複，使用者要求合併成
// 一則：
//   1. 全部繁體中文，不出現英文標題；檢查項目的type代碼後面一定附中文說明。
//   2. BLOCKING=0時一行帶過；>0時列出每一項明細，MINOR/EXTERNAL只顯示數量。
//   3. BLOCKING明細裡，連續超過一天都還在的項目，後面標示「（已連續N天）」（N=1時不標，只有
//      第一天出現時才不標，避免每天都寫「已連續1天」這種沒有資訊量的字）。
//   4. 自己恢復的（昨天BLOCKING、今天不是）不產生任何通知，自然從anomalies清單消失即可。
import { classifySeverity, anomalyFingerprint, type Severity } from "./severity";

// anomalies 陣列真正的型別很長（見 route.ts 的 anomalies 組裝），這裡只取用得到的欄位，其餘用
// unknown 保留——避免這個檔案變成route.ts異動的額外耦合點。
export type AnomalyLike = {
  type: string;
  category?: string;
  jobId?: string;
  label?: string;
  reason?: string | null;
  reasons?: string[];
  newCodes?: string[];
  codes?: string[];
  count?: number;
  checkedCount?: number;
  gapCount?: number;
  laggingCount?: number;
  coveragePct?: number;
  currentCount?: number;
  minBaseline?: number;
  missing?: Array<{ label: string; lastSuccessAt?: string | null }>;
  // route.ts的anomalies陣列是30多種形狀各異的物件組成的union（COVERAGE的items、
  // MONEYDJ_*的codes、各種MISMATCH的mismatches…每一種內部欄位都不一樣），這裡故意用unknown[]
  // 收，由formatAnomalyDetail()用duck-typing安全地取值，不逐一對齊每個type在route.ts裡的確切型別
  // ——那樣只會讓這個檔案變成route.ts每次新增異常type就要同步改的耦合點。
  items?: unknown[];
  mismatches?: unknown[];
  invalid?: unknown[];
  rows?: unknown[];
  [key: string]: unknown;
};

/** 從列表型欄位（items/mismatches/invalid/codes）裡盡量找出一個可顯示的識別字串，用duck-typing
 * 而不是假設固定欄位名稱——route.ts裡不同type的列表，每一筆的識別欄位名稱都不一樣
 * （code/fundCode/symbol/name...)。 */
function displayIdOf(x: unknown): string {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const v = o.code ?? o.fundCode ?? o.symbol ?? o.ticker ?? o.name;
    if (typeof v === "string") return v;
  }
  return "?";
}

// 2026-11-05使用者核准：每個type一律附中文說明，訊息裡不留英文標題給使用者自己猜。沒列在這裡的
// 新type會退回「未分類異常」，不會讓整則訊息排版壞掉或丟例外。
const TYPE_LABELS: Record<string, string> = {
  PIPELINE: "排程異常",
  FRESHNESS: "資料新鮮度落後",
  ETF_DATA_SOURCE_GAP: "ETF缺少價格來源",
  TW_EXCHANGE_WIDE_DATA_GAP: "全交易所價格缺口",
  ACTIVE_ETF_OFFICIAL_HOLDINGS_GAP: "主動式ETF持股未更新",
  ETF_HISTORY_GAP: "ETF價格歷史落後",
  COVERAGE: "核心母體覆蓋率異常",
  YAHOO_TW_RETURN_MISMATCH: "報酬率與Yahoo奇摩不符",
  YAHOO_TW_RETURN_FETCH_FAILED: "Yahoo奇摩報酬率抓取失敗",
  FRED_COMMODITY_MISMATCH: "商品數值與FRED不符",
  TDCC_DIVIDEND_MISMATCH: "配息金額與集保不符",
  FUND_CURRENCY_OFFICIAL_MISMATCH: "幣別與官方不符",
  FUND_CURRENCY_INVALID_FORMAT: "幣別格式錯誤",
  NEW_FUND_CREATE_FAILED: "新基金建檔失敗",
  NEW_FUND_ISIN_NAME_CONFLICT: "新基金ISIN/名稱衝突",
  NEW_FUND_SKIPPED_INVALID_CURRENCY: "新基金因幣別無效略過建檔",
  YAHOO_FUND_CURRENCY_UNRESOLVED: "基金幣別無法解析",
  RETAIL_RESTRICTED_ETF_COUNT_DROPPED: "應排除商品數量異常下降",
  STOCK_TECHNICAL_LAG: "個股技術指標落後",
  FUND_HOLDINGS_LAG: "基金持股資料落後",
  MONEYDJ_PARSE_FAILED: "持股資料解析失敗",
  MONEYDJ_NAME_ONLY_NO_WEIGHT: "持股只有名稱缺權重",
  LOCAL_SCHEDULE_NOT_REPORTED: "本機排程未回報",
  OUT_OF_SCOPE_JOB_REACTIVATED: "已下架排程又出現執行紀錄",
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? "未分類異常";
}

/** 每一種異常type的人類可讀明細——只給BLOCKING項目用（MINOR/EXTERNAL在摘要裡只算數量，不展開），
 * 盡量在一行內講清楚「是什麼」，列表型的（items/codes/mismatches）只取前3筆、附總數，避免單一
 * 問題洗版整則訊息。 */
export function formatAnomalyDetail(a: AnomalyLike): string {
  const idPart = a.jobId ? `(${a.jobId})` : a.label ? `(${a.label})` : "";
  const head = `${a.type}（${typeLabel(a.type)}）${idPart}`;
  const sampleCodes = (list: unknown[] | undefined, n = 3): string => {
    if (!list || list.length === 0) return "";
    const shown = list.slice(0, n).map(displayIdOf).join(", ");
    return list.length > n ? `${shown} 等共${list.length}筆` : shown;
  };
  switch (a.type) {
    case "PIPELINE":
      return `${head}：${(a.reasons ?? []).join(", ")}`;
    case "FRESHNESS":
      return `${head}：${a.reason ?? "資料落後"}`;
    case "ETF_DATA_SOURCE_GAP":
      return `${head}：${a.newCodes?.length ?? 0}檔新代碼完全沒有價格來源${a.newCodes?.length ? `（${a.newCodes.slice(0, 5).join(", ")}${a.newCodes.length > 5 ? " 等" : ""}）` : ""}`;
    case "TW_EXCHANGE_WIDE_DATA_GAP":
      return `${head}：全交易所價格缺口`;
    case "ACTIVE_ETF_OFFICIAL_HOLDINGS_GAP":
      return `${head}：${a.items?.length ?? 0}檔主動式ETF持股停在舊資料（${sampleCodes(a.items)}）`;
    case "ETF_HISTORY_GAP":
      return `${head}：${a.gapCount ?? a.items?.length ?? 0}檔價格歷史落後（${sampleCodes(a.items)}）`;
    case "COVERAGE":
      return `${head}：${a.reason ?? "覆蓋率異常"}${a.items?.length ? `（${sampleCodes(a.items)}）` : ""}`;
    case "YAHOO_TW_RETURN_MISMATCH":
      return `${head}：${a.mismatches?.length ?? 0}檔報酬率跟Yahoo奇摩對不起來（${sampleCodes(a.mismatches)}）`;
    case "FRED_COMMODITY_MISMATCH":
      return `${head}：${a.mismatches?.length ?? 0}項商品數值跟FRED對不起來（${sampleCodes(a.mismatches)}）`;
    case "TDCC_DIVIDEND_MISMATCH":
      return `${head}：${a.mismatches?.length ?? 0}筆配息跟TDCC對不起來（${sampleCodes(a.mismatches)}）`;
    case "FUND_CURRENCY_OFFICIAL_MISMATCH":
      return `${head}：${a.mismatches?.length ?? 0}檔幣別跟官方對不起來（${sampleCodes(a.mismatches)}）`;
    case "FUND_CURRENCY_INVALID_FORMAT":
      return `${head}：${a.invalid?.length ?? 0}檔幣別格式不是三碼ISO代碼（${sampleCodes(a.invalid)}）`;
    case "NEW_FUND_CREATE_FAILED":
      return `${head}：${a.count ?? a.items?.length ?? 0}檔新基金建檔失敗（${sampleCodes(a.items)}）`;
    case "NEW_FUND_ISIN_NAME_CONFLICT":
      return `${head}：${a.count ?? a.items?.length ?? 0}檔新基金ISIN/名稱衝突（${sampleCodes(a.items)}）`;
    case "YAHOO_FUND_CURRENCY_UNRESOLVED":
      return `${head}：${a.count ?? 0}檔基金幣別無法從Yahoo解析`;
    case "RETAIL_RESTRICTED_ETF_COUNT_DROPPED":
      return `${head}：應排除商品數量從${a.minBaseline ?? "?"}降到${a.currentCount ?? "?"}，可能誤放行`;
    case "STOCK_TECHNICAL_LAG":
      return `${head}：${a.laggingCount ?? 0}檔個股技術指標落後最新價格`;
    case "FUND_HOLDINGS_LAG":
      return `${head}：當月已有${a.coveragePct?.toFixed(1) ?? "?"}%基金到位，仍有${a.laggingCount ?? 0}檔落後`;
    case "MONEYDJ_PARSE_FAILED":
      return `${head}：${a.count ?? 0}檔持股解析失敗（${sampleCodes(a.codes)}）`;
    case "MONEYDJ_NAME_ONLY_NO_WEIGHT":
      return `${head}：${a.count ?? 0}檔持股只剩名稱沒有權重（${sampleCodes(a.codes)}）`;
    case "LOCAL_SCHEDULE_NOT_REPORTED":
      return `${head}：${(a.missing ?? []).map((m) => m.label).join(", ")} 今天沒有回報`;
    case "OUT_OF_SCOPE_JOB_REACTIVATED":
      return `${head}：已下架job又出現新的執行紀錄`;
    default:
      return `${head}：${a.reason ?? JSON.stringify(a).slice(0, 150)}`;
  }
}

export function buildDailySummary(input: {
  today: string;
  severitySummary: { blocking: number; minor: number; external: number };
  blockingAnomalies: AnomalyLike[];
  /** fingerprint -> 連續天數（含今天）。沒有這個問題的fingerprint可以不放進來，當作1天處理。 */
  consecutiveDaysByFingerprint?: Record<string, number>;
}): string {
  const { today, severitySummary, blockingAnomalies, consecutiveDaysByFingerprint = {} } = input;
  const { blocking, minor, external } = severitySummary;

  if (blocking === 0) {
    return `✅ 今日無需處理的異常（一般 ${minor} 項、外部 ${external} 項）`;
  }

  const lines: string[] = [];
  lines.push(`🔴 每日健康報告 ${today}：${blocking} 項需要處理`);
  for (const a of blockingAnomalies) {
    const days = consecutiveDaysByFingerprint[anomalyFingerprint(a)] ?? 1;
    const suffix = days > 1 ? `（已連續 ${days} 天）` : "";
    lines.push(`- ${formatAnomalyDetail(a)}${suffix}`);
  }
  lines.push(`一般 ${minor} 項、外部 ${external} 項，明細見後台`);
  return lines.join("\n");
}

export type { Severity };
export { classifySeverity };
