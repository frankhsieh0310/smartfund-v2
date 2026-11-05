// 2026-11-05（使用者核准定案前的草案，待使用者確認對照表後才算 DEFINITIVE）: 健康報告三級分類。
//
// 分級規則（使用者原話，逐條對應到下面的程式邏輯）：
//   1. 嚴重 BLOCKING：使用者會看到錯誤資料，或核心功能壞掉。包括價格、淨值、持股寫錯；核心資料
//      停在舊日期但畫面沒有標示；反查、持股透視、比較、搜尋跑不出結果。
//   2. 一般 MINOR：次要欄位缺漏或延遲，且畫面已顯示「更新中」或最後更新日期。包括經理人、費率、
//      配置、期間報酬率的缺漏；排程重試後成功；非核心排程偶發逾時但當天有補上。
//   3. 外部 EXTERNAL：來源本身沒更新、來源擋連線（含 MoneyDJ 的 EXTERNAL_DELAY）、來源休市，且
//      系統已自動處理、畫面沒有顯示錯誤資料。
//   規則三（保守原則）：只要使用者有可能看到錯的數字，就一律歸成 BLOCKING，不准為了過關降級。
//
// 2026-11-05（使用者核准修正，取代前一版用 jobId 白名單判斷「核心排程」的做法）: BLOCKING 要看
// 「資料結果」，不是看「排程有沒有失敗」。這份報告本來就有兩種不同性質的檢查：
//   - 資料結果型（COVERAGE/ACTIVE_ETF_OFFICIAL_HOLDINGS_GAP/ETF_HISTORY_GAP/FRESHNESS/
//     TW_EXCHANGE_WIDE_DATA_GAP/ETF_DATA_SOURCE_GAP/各種 MISMATCH/幣別/新基金建檔失敗等）——
//     每一種都是「直接去比對使用者實際會看到的資料 vs 官方最新資料」，SYSTEM 證據本身就等於
//     「使用者此刻看到的是錯的或舊的資料」，符合 BLOCKING 的定義。
//   - 排程症狀型（PIPELINE 的 run-log 判斷、LOCAL_SCHEDULE_NOT_REPORTED）——這些只能證明「某支
//     排程這次跑失敗/卡住/逾時/本機沒回報」，不能證明使用者畫面上的資料真的是錯的：排程失敗後
//     可能下一次就補上了，或者同一份資料本來就有別的排程/來源在供應。如果排程症狀對應的資料
//     真的落後，上面那些資料結果型檢查會獨立偵測到、自己產生一筆 BLOCKING——不需要排程症狀型
//     也跟著升級，那樣會變成同一個落後用兩筆異常重複計分，而且排程「失敗」本身常常不代表資料
//     「真的」落後（例如 checkPipelineRunLog 的 hadFullPassToday/LAST_RUN_PARTIAL 邏輯本身已經
//     對「隔天補上」做了寬容）。所以 PIPELINE 跟 LOCAL_SCHEDULE_NOT_REPORTED 的 SYSTEM 證據一律
//     MINOR（排程本身的健康度/人工追查線索，仍然要列出來，只是不升級成上架門檻）。
//
// 分級順序：
//   (a) anomaly.category === 'EXTERNAL_DELAY' 一律 EXTERNAL（這個 category 本身在 checks.ts /
//       route.ts 裡已經是「有證據」才會標上去的——官方自己的資料也還是舊的，或對方回了
//       401/403/429——不是我方猜測，直接對應使用者定義的 EXTERNAL。
//   (b) category === 'SYSTEM' 的，依 anomaly.type 分類：資料結果型 type → BLOCKING；
//       排程症狀型（PIPELINE、LOCAL_SCHEDULE_NOT_REPORTED）→ MINOR。
export type Severity = "BLOCKING" | "MINOR" | "EXTERNAL";

// 資料結果型：每一種都是直接拿使用者會看到的資料去跟官方/來源最新資料比對出來的證據，SYSTEM
// 分類本身就代表「此刻顯示的是錯的或舊的資料」。
const BLOCKING_ANOMALY_TYPES = new Set([
  "MONEYDJ_PARSE_FAILED", "MONEYDJ_NAME_ONLY_NO_WEIGHT", // 持股解析失敗/只剩名稱沒權重=持股寫錯
  "ETF_DATA_SOURCE_GAP", // 新代碼完全沒有價格來源=該檔核心功能壞掉
  "TW_EXCHANGE_WIDE_DATA_GAP", // 全交易所價格缺口（官方有資料、我們沒有）
  "ACTIVE_ETF_OFFICIAL_HOLDINGS_GAP", // 主動式ETF持股停在舊資料（本類型只有SYSTEM才會走到這裡，EXTERNAL_DELAY在(a)已經分流）
  "ETF_HISTORY_GAP", // 價格歷史落後同交易所peer（本類型只有SYSTEM證據才會走到這裡）
  "COVERAGE", // 只有 core_universe_fund/core_universe_etf 的 SYSTEM 證據才會走到這裡
  "YAHOO_TW_RETURN_MISMATCH", "FRED_COMMODITY_MISMATCH", "TDCC_DIVIDEND_MISMATCH", // 規則三：已證實數值對不起來
  "FUND_CURRENCY_OFFICIAL_MISMATCH", "FUND_CURRENCY_INVALID_FORMAT", // 幣別錯誤=顯示的金額單位可能是錯的
  "NEW_FUND_CREATE_FAILED", "NEW_FUND_ISIN_NAME_CONFLICT", "YAHOO_FUND_CURRENCY_UNRESOLVED",
  "RETAIL_RESTRICTED_ETF_COUNT_DROPPED", // 應排除的商品變回可購買=誤導使用者可購買性
  "STOCK_TECHNICAL_LAG", // 2026-11-05: 價格已經有新一天、技術指標還停在舊日期=使用者看到的技術分析可能是舊的
  "FUND_HOLDINGS_LAG", // 2026-11-05: 當月已有≥50%基金拿到月底資料時，剩下還沒到位的才算異常
]);
const CORE_FRESHNESS_LABELS = new Set(["tw_stock_price", "domestic_fund_nav"]);

// 排程症狀型：只證明「這支排程這次有異狀」，不是直接的資料結果證據——一律 MINOR（仍然列出來，
// 但不擋上架）。
const SCHEDULE_SYMPTOM_TYPES = new Set(["PIPELINE", "LOCAL_SCHEDULE_NOT_REPORTED"]);

/** anomaly 是 route.ts `anomalies` 陣列裡的單筆物件（已經有 type/category，部分有 jobId/label）。
 *  沒列進 BLOCKING_ANOMALY_TYPES 的其他 type 預設 MINOR（白名單式「資料結果才升級」，避免遺漏
 *  判斷時意外被歸到最嚴重那一級）。*/
export function classifySeverity(anomaly: { type: string; category?: string; jobId?: string; label?: string }): Severity {
  if (anomaly.category === "EXTERNAL_DELAY") return "EXTERNAL";
  if (SCHEDULE_SYMPTOM_TYPES.has(anomaly.type)) return "MINOR";
  if (anomaly.type === "FRESHNESS") {
    return anomaly.label && CORE_FRESHNESS_LABELS.has(anomaly.label) ? "BLOCKING" : "MINOR";
  }
  if (BLOCKING_ANOMALY_TYPES.has(anomaly.type)) return "BLOCKING";
  return "MINOR";
}

/** 整份報告（anomalies 陣列）彙總成三級筆數，給 buildDailySummary 跟上架判斷共用。*/
export function summarizeSeverity(anomalies: Array<{ type: string; category?: string; jobId?: string; label?: string }>): {
  blocking: number; minor: number; external: number;
  blockingItems: string[]; minorItems: string[]; externalItems: string[];
} {
  const blockingItems: string[] = [];
  const minorItems: string[] = [];
  const externalItems: string[] = [];
  for (const a of anomalies) {
    const sev = classifySeverity(a);
    const label = a.jobId ? `${a.type}:${a.jobId}` : a.label ? `${a.type}:${a.label}` : a.type;
    if (sev === "BLOCKING") blockingItems.push(label);
    else if (sev === "EXTERNAL") externalItems.push(label);
    else minorItems.push(label);
  }
  return {
    blocking: blockingItems.length, minor: minorItems.length, external: externalItems.length,
    blockingItems, minorItems, externalItems,
  };
}
