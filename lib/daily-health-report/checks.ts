// Pure, DB-query-injected health checks for the daily report (no Next.js/Prisma import so this stays
// unit-testable with a mock QueryFn, same convention as every other pipeline this session).
import { lastScheduledOccurrence } from "./scheduleRegistry";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type PipelineHealth = {
  jobId: string;
  hasRunInLast24h: boolean;
  errorCount24h: number;
  writeErrorCount24h: number;
  lastStatus: string | null;
  lastError: string | null;
  anomaly: boolean;
  anomalyReasons: string[];
  /** 2026-10-19: errors matching a job's benignErrorPattern (source genuinely has no data to
   * disclose, not a pipeline failure) -- counted here instead of errorCount24h, never contributes
   * to anomaly. */
  sourceUnavailableCount24h: number;
};

// 2026-10-19（使用者撤回上午的排除，改成更嚴格的規則）: 上午曾經把 CLOUD_MONEYDJ_FUND 的
// MONEYDJ_DISCLOSED_HOLDINGS_MISSING 整類排除，當時的依據（ACCA190 一筆抽樣）不夠——事後用
// 30 小時失敗紀錄隨機抽 10 檔實際打開 MoneyDJ 頁面核對，9/10 其實都有真實持股表，是解析程式的
// bug（見 lib/cloud-ingestion/moneydjFundDisclosure.ts 同日的修正），不是「來源無資料」。
// 現在只有 MONEYDJ_HOLDINGS_NOT_DISCLOSED（頁面自己明確顯示「目前無投資明細資料」的那一種）
// 才算「來源無資料、不計入異常」；MONEYDJ_HOLDINGS_NAME_ONLY_NO_WEIGHT（有名稱沒比例，已知
// 型態但還不能寫入，待 schema 核准）與 MONEYDJ_HOLDINGS_PARSE_FAILED（其他真的解析不出來的）
// 一律算異常。
const BENIGN_ERROR_PATTERNS: Record<string, RegExp> = {
  CLOUD_MONEYDJ_FUND: /MONEYDJ_HOLDINGS_NOT_DISCLOSED/,
};

// Checks production_scheduler_runs for a given job_id over the last 24h. A pipeline with ZERO runs in
// the window is itself an anomaly (the schedule expects at least one run per day for all six jobs this
// covers) -- never silently treated as "fine because nothing to report".
//
// 2026-10-19（使用者核准，修正昨天的 B 類誤報——這不是使用者要求保留的規則，只有基準日邏輯
// 是使用者昨天要求暫時沿用）：
//
// (a) NO_RUN_IN_LAST_24H 原本是死板的「過去24小時有沒有任何一次執行」，對平日/特定時段限定
//     的排程（例如只在平日 06-08 點跑的 TW_ETF_DAY_CHANGE）會在健康報告自己 08:30 查詢的
//     時間點之前誤判成「沒跑」。改成用 lib/daily-health-report/scheduleRegistry.ts 的真實排程
//     設定算出「這支排程最近一次『應該』已經執行的時間點」，只有真的超過那個時間（留 30 分鐘
//     寬限期，涵蓋平台排程本身的執行延遲）還沒有對應的執行紀錄，才算異常。查不到排程設定的
//     工作（例如本身就是用自我循環 workflow 驅動、沒有單一 cron 表達式可用的排程）維持原本
//     「過去24小時」的保守判斷，不是這次的修正範圍。
// (b) LAST_RUN_PARTIAL 原本只看「最近一次執行」的狀態，對有 checkpoint 分段執行的排程
//     （例如每次只處理一小批、靠多次執行慢慢清完母體），健康報告剛好查到還在跑的那一批
//     就會誤判。改成看過去24小時的「所有」執行紀錄：只要其中任何一筆是 COMPLETED，或任何一筆
//     的 checkpoint 回報 wrapped=true（代表母體已經跑完整整一圈），就不算異常——真正異常的
//     情況是「過去24小時全部都是 PARTIAL/FAILED，完全沒有一次跑完整個母體」。
export async function checkPipelineRunLog(query: QueryFn, jobId: string): Promise<PipelineHealth> {
  const rows = await query(
    `SELECT status, error, details->>'write_error_count' AS write_error_count, started_at,
            details->'checkpoint_after'->>'wrapped' AS wrapped
       FROM production_scheduler_runs
      WHERE job_id = $1 AND started_at > now() - interval '24 hours'
      ORDER BY started_at DESC`,
    [jobId],
  );

  const benignPattern = BENIGN_ERROR_PATTERNS[jobId];
  const isBenignError = (errMsg: string | null) => !!errMsg && !!benignPattern && benignPattern.test(errMsg);
  const errorCount24h = rows.filter((r) => r.error != null && !isBenignError(r.error)).length;
  const sourceUnavailableCount24h = rows.filter((r) => isBenignError(r.error)).length;
  const writeErrorCount24h = rows.reduce((sum, r) => sum + (Number(r.write_error_count) || 0), 0);
  const last = rows[0] ?? null;

  const anomalyReasons: string[] = [];

  // (a) 排程感知的 NO_RUN 判斷
  const scheduledAt = lastScheduledOccurrence(jobId, new Date());
  let hasRunInLast24h: boolean;
  if (scheduledAt) {
    const graceMs = 30 * 60 * 1000;
    const overdueRows = await query(
      `SELECT 1 FROM production_scheduler_runs WHERE job_id = $1 AND started_at >= $2::timestamptz LIMIT 1`,
      [jobId, scheduledAt.toISOString()],
    );
    hasRunInLast24h = overdueRows.length > 0;
    if (!hasRunInLast24h && Date.now() - scheduledAt.getTime() > graceMs) anomalyReasons.push("NO_RUN_IN_LAST_24H");
  } else {
    hasRunInLast24h = rows.length > 0;
    if (!hasRunInLast24h) anomalyReasons.push("NO_RUN_IN_LAST_24H");
  }

  if (errorCount24h > 0) anomalyReasons.push(`ERROR_COUNT_${errorCount24h}`);
  if (writeErrorCount24h > 0) anomalyReasons.push(`WRITE_ERROR_COUNT_${writeErrorCount24h}`);

  // (b) 當天是否已完整跑過一輪（COMPLETED 或 checkpoint wrapped=true 皆算），只有兩者都沒有
  //     才算真正的 PARTIAL 異常。
  const hadFullPassToday = rows.some((r) => r.status === "COMPLETED" || r.wrapped === "true");
  const allFailedOrPartial = rows.length > 0 && rows.every((r) => r.status === "PARTIAL" || r.status === "FAILED");
  if (!hadFullPassToday && allFailedOrPartial) {
    if (last?.status === "PARTIAL") anomalyReasons.push("LAST_RUN_PARTIAL");
    if (last?.status === "FAILED") anomalyReasons.push("LAST_RUN_FAILED");
  } else if (last?.status === "FAILED" && !hadFullPassToday) {
    anomalyReasons.push("LAST_RUN_FAILED");
  }

  return {
    jobId,
    hasRunInLast24h,
    errorCount24h,
    sourceUnavailableCount24h,
    writeErrorCount24h,
    lastStatus: last?.status ?? null,
    lastError: last?.error ?? null,
    anomaly: anomalyReasons.length > 0,
    anomalyReasons,
  };
}

export type MoneydjParseFailureResult = {
  notDisclosedCount: number; // genuinely no data (MONEYDJ_HOLDINGS_NOT_DISCLOSED) -- benign
  nameOnlyCount: number; // known shape, no weight yet, pending schema approval -- not benign
  parseFailedCount: number; // anything else -- a real parser bug, not benign
  /** Distinct fund codes behind nameOnlyCount/parseFailedCount, from the 24h window's sampled
   * failures (production_scheduler_runs.details.sample_failures caps at 5 per run, so this is a
   * representative sample, not necessarily every affected fund -- still real codes, never guessed). */
  nameOnlyCodes: string[];
  parseFailedCodes: string[];
};

// 2026-10-19（使用者核准）: checkPipelineRunLog's errorCount24h/sourceUnavailableCount24h only ever
// look at ONE summary string per run (production_scheduler_runs.error, built as "{N} failures; e.g.
// {first failure's reason}") -- accurate enough for most jobs, but CLOUD_MONEYDJ_FUND's user-facing
// requirement is per-FUND: list the actual codes behind any real parse failure, not just classify
// the whole run by whichever failure happened to be sampled first. This reads the richer
// details.sample_failures array (up to 5 {code,reason} pairs per run) and classifies each one
// individually against the three error classes moneydjFundDisclosure.ts now throws.
export async function checkMoneydjParseFailures(query: QueryFn, windowHours = 24): Promise<MoneydjParseFailureResult> {
  const rows = await query(
    `SELECT details->'sample_failures' AS sample_failures
       FROM production_scheduler_runs
      WHERE job_id = 'CLOUD_MONEYDJ_FUND' AND started_at > now() - interval '${windowHours} hours'`,
    [],
  );
  let notDisclosedCount = 0;
  const nameOnlyCodes = new Set<string>();
  const parseFailedCodes = new Set<string>();
  for (const row of rows) {
    const sampleFailures: Array<{ code: string; reason: string }> = row.sample_failures ?? [];
    for (const f of sampleFailures) {
      if (/MONEYDJ_HOLDINGS_NOT_DISCLOSED/.test(f.reason)) { notDisclosedCount++; continue; }
      if (/MONEYDJ_HOLDINGS_NAME_ONLY_NO_WEIGHT/.test(f.reason)) { nameOnlyCodes.add(f.code); continue; }
      parseFailedCodes.add(f.code);
    }
  }
  return {
    notDisclosedCount,
    nameOnlyCount: nameOnlyCodes.size,
    parseFailedCount: parseFailedCodes.size,
    nameOnlyCodes: [...nameOnlyCodes].slice(0, 30),
    parseFailedCodes: [...parseFailedCodes].slice(0, 30),
  };
}

export type DataSourceGapResult = {
  nullCount: number;
  codes: string[]; // up to 10, for display
  knownCodes: string[]; // already-documented gaps (e.g. a suspected-delisted symbol) -- never re-raised as a fresh anomaly
  newCodes: string[]; // anything NOT already documented -- these alone drive `anomaly`
  anomaly: boolean;
};

// 2026-10-13: 33 TPEx ETFs were found with etfs.data_source = NULL (silently excluded from
// market-close-sync's core universe -- see lib/market-close-sync/coreUniverse.ts). 32 were backfilled;
// 00838B could not be (Yahoo has no data for 00838B.TWO at all, "No data found, symbol may be
// delisted"). Listed here so it surfaces every day as a known, already-investigated data point
// ("known/suspected delisted") rather than a fresh warning that looks identical to a brand-new gap.
export const KNOWN_DATA_SOURCE_GAPS: ReadonlySet<string> = new Set(["00838B"]);

// is_active TWSE/TPEx ETFs missing a data_source entirely fall out of market-close-sync's core
// universe without ANY error, log line, or alert (confirmed live 2026-10-13 -- this is exactly how 33
// funds went unnoticed for days). This check exists so a NEW gap (as opposed to the one already
// known and backfilled) is never silent again.
export async function checkEtfDataSourceGap(query: QueryFn): Promise<DataSourceGapResult> {
  const rows = await query(
    `SELECT code FROM etfs WHERE is_active = true AND exchange IN ('TWSE','TPEx') AND data_source IS NULL ORDER BY code`,
    [],
  );
  const allCodes: string[] = rows.map((r) => r.code);
  const knownCodes = allCodes.filter((c) => KNOWN_DATA_SOURCE_GAPS.has(c));
  const newCodes = allCodes.filter((c) => !KNOWN_DATA_SOURCE_GAPS.has(c));
  return { nullCount: allCodes.length, codes: allCodes.slice(0, 10), knownCodes, newCodes, anomaly: newCodes.length > 0 };
}

export type DataFreshnessResult = {
  label: string;
  latestDate: string | null;
  staleDays: number | null;
  anomaly: boolean;
  anomalyReason: string | null;
};

// Generic "is this table's latest date reasonably recent" check. maxStaleDays accounts for
// weekends/holidays loosely (not a full trading-calendar lookup) -- documented limitation, not a bug.
export function evaluateFreshness(label: string, latestDateIso: string | null, maxStaleDays: number): DataFreshnessResult {
  if (!latestDateIso) {
    return { label, latestDate: null, staleDays: null, anomaly: true, anomalyReason: "NO_DATA" };
  }
  const latest = new Date(latestDateIso);
  const staleDays = Math.floor((Date.now() - latest.getTime()) / 86400000);
  const anomaly = staleDays > maxStaleDays;
  return { label, latestDate: latestDateIso, staleDays, anomaly: anomaly ? true : false, anomalyReason: anomaly ? `STALE_${staleDays}D` : null };
}

export type CoverageResult = {
  label: string;
  universeCount: number;
  latestDate: string | null;
  coveredCount: number;
  coveragePct: number | null;
  missingSample: string[];
  anomaly: boolean;
  anomalyReason: string | null;
  // 2026-10-18 (使用者規則定案): 基準日的決定方式必須在「輸出」本身講清楚，不能只寫在程式碼
  // 註解裡——否則看報告的人會誤以為這是真正的交易日曆。固定兩種值：
  //   "RECENT_10D_BEST_COVERAGE"：近 10 天內覆蓋筆數最多的那一天，不是交易日曆。
  //   "LATERAL_FRESHNESS_WINDOW"：不挑單一基準日，改成「universe 裡有多少比例在最近 N 天內
  //     有資料」（etf_history/fund_history 的 LATERAL 新鮮度檢查用這種）。
  baselineMethod: "RECENT_10D_BEST_COVERAGE" | "LATERAL_FRESHNESS_WINDOW" | "TRADING_CALENDAR_WEEKDAY";
};

// 2026-10-18 (使用者規則定案，第 2b 項): 排程狀態（COMPLETED/PARTIAL）只代表「這次執行有沒有
// 出錯」，不代表「母體裡的資料真的每天都更新到」。這組函式改成直接量「最近一個排程自己有寫入
// 資料的日期，母體裡有多少比例真的有那天的資料」。
//
// 已知限制（誠實記錄，不是沒想到）：
// 1. 不是完整的交易日曆查詢（跟既有 evaluateFreshness 的限制一樣），用「表裡最近出現的日期」
//    當作「預期更新到的日期」，不是真的去查該市場是否休市。
// 2. 沒有排除「當地休市」「來源本身沒有報價（停市但仍標 active）」這兩類本次稽核已經確認過的
//    合理缺口，所以覆蓋率沒到 100% 不等於一定是真問題，需要人工對照當天已知的合理缺口清單。
// 2b. 拿最近 10 天「覆蓋筆數最多」的那一天當基準日，不是單純拿「表裡最新出現的日期」——
//    VERIFIED 這次用真實資料試跑時發現，週末（非交易日）偶爾還是會有少量零星寫入，若直接拿
//    「最新日期」當基準，會把一個只有 2~4% 覆蓋率的非交易日誤判成「幾乎全部排程都壞了」。拿
//    覆蓋筆數最多的那天當基準，至少能避開這個最明顯的假警報來源，但仍不是真正的交易日曆。
// 3. etf_history（1,836 萬筆）／fund_history（8,487 萬筆）這兩張表故意沒有在這裡做覆蓋率查詢
//    ——VERIFIED 這兩張表的索引都是 (id欄, date) 複合索引，date 當 WHERE 條件用不到索引，
//    之前拿 85M 筆的 fund_history 試過兩次，在這支路由僅有的 60 秒 maxDuration 預算內做這種
//    查詢風險太高（可能把健康報告本身拖垮），沒有不經同意就加新索引（DDL），所以這兩張表目前
//    仍只靠上面的排程狀態監控，覆蓋率查核留作已知待辦。
async function evaluateCoverage(
  query: QueryFn,
  label: string,
  table: string,
  dateCol: string,
  idCol: string,
  universeCountSql: string,
  suppressAnomaly = false,
): Promise<CoverageResult> {
  const universeRows = await query(universeCountSql, []);
  const universeCount = Number(universeRows[0]?.n ?? 0);
  if (universeCount === 0) {
    return { label, universeCount: 0, latestDate: null, coveredCount: 0, coveragePct: null, missingSample: [], anomaly: false, anomalyReason: null, baselineMethod: "RECENT_10D_BEST_COVERAGE" };
  }
  // 基準日 = 最近 10 天內「覆蓋筆數最多」的那一天，不是單純「最新出現的日期」，見上方 2b 註解。
  const bestDayRows = await query(
    `SELECT ${dateCol}::text AS d, COUNT(DISTINCT ${idCol})::int AS n FROM ${table}
     WHERE ${dateCol} > now() - interval '10 days' GROUP BY ${dateCol} ORDER BY n DESC, d DESC LIMIT 1`,
    [],
  );
  const latestDate = bestDayRows[0]?.d ?? null;
  const coveredCount = Number(bestDayRows[0]?.n ?? 0);
  if (!latestDate) {
    return { label, universeCount, latestDate: null, coveredCount: 0, coveragePct: 0, missingSample: [], anomaly: !suppressAnomaly, anomalyReason: "NO_RECENT_DATA", baselineMethod: "RECENT_10D_BEST_COVERAGE" };
  }
  const coveragePct = (coveredCount / universeCount) * 100;
  const anomaly = !suppressAnomaly && coveragePct < 100;
  return {
    label, universeCount, latestDate, coveredCount, coveragePct, missingSample: [],
    anomaly, anomalyReason: anomaly ? `COVERAGE_${coveragePct.toFixed(1)}PCT` : null,
    baselineMethod: "RECENT_10D_BEST_COVERAGE",
  };
}

// futures_technical_analytics -- small table (safe to scan), real universe is CORE_COMMODITY_ROOTS
// (27 roots, lib/cron/commodityUpdate.ts), NOT futures_product_roots (891 rows -- that's every
// contract-month row ever stored, not this job's actual per-commodity universe; using it as the
// denominator was a mistake caught during this round's audit).
// 2026-10-19（使用者核准，修正「全體最佳日」基準）: 這 27 個核心商品全部是美股市場商品
// （CBOT／COMEX-NYMEX／ICE／Livestock，vercel.json 排程皆平日週一到週五 19:00-21:30 UTC
// 觸發），基準日改成「最近一個已經完整結束的平日」，不是「近10天覆蓋筆數最多的那天」——
// 後者會不小心選到覆蓋率剛好較高、但不是最新交易日的某一天，掩蓋掉真正的缺口。健康報告固定
// 在 UTC 00:30 查詢，這個時間點永遠晚於前一個平日全部排程的觸發時間，所以「最近一個平日」
// 一定已經跑完，可以直接當基準，不用再找「最佳日」。
// 已知限制（誠實記錄）：只排除週六週日，沒有查真正的美股假日行事曆，遇到美股假日當天仍會被
// 誤判成「應該有資料」，跟既有 evaluateFreshness 的限制相同，不是本次新增的缺口。
function lastCompletedUsTradingWeekday(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1); // start from "yesterday" -- today's own syncs haven't fired yet
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1); // skip Sat/Sun
  return d.toISOString().slice(0, 10);
}

export async function checkCommodityTechnicalCoverage(query: QueryFn, coreRootIds: string[], now: Date = new Date()): Promise<CoverageResult> {
  if (coreRootIds.length === 0) return { label: "commodity_technical", universeCount: 0, latestDate: null, coveredCount: 0, coveragePct: null, missingSample: [], anomaly: false, anomalyReason: null, baselineMethod: "TRADING_CALENDAR_WEEKDAY" };
  const targetDate = lastCompletedUsTradingWeekday(now);
  const dayRows = await query(
    `SELECT COUNT(DISTINCT root_id)::int AS n FROM futures_technical_analytics
     WHERE root_id = ANY($1::uuid[]) AND observed_at::date = $2::date`,
    [coreRootIds, targetDate],
  );
  const coveredCount = Number(dayRows[0]?.n ?? 0);
  const coveragePct = (coveredCount / coreRootIds.length) * 100;
  const anomaly = coveragePct < 100;
  return { label: "commodity_technical", universeCount: coreRootIds.length, latestDate: targetDate, coveredCount, coveragePct, missingSample: [], anomaly, anomalyReason: anomaly ? `COVERAGE_${coveragePct.toFixed(1)}PCT` : null, baselineMethod: "TRADING_CALENDAR_WEEKDAY" };
}

// fund_performances -- small table (12k rows, safe to scan). 2026-10-18 correction: universe is
// NOT "all active funds" -- VERIFIED the 23,053 yahoo-provider funds have ZERO rows in this table
// ever (their returns live in fund_history's own return_1m/return_3m/... columns instead, a
// completely different write path -- see checkFundHistoryFreshness below). Narrowed to the same
// "domestic, not yahoo/SEC" filter the existing domestic_fund_nav freshness check below already
// uses -- an earlier attempt that explicitly listed `data_provider IN ('SITCA','MoneyDJ',
// 'tdcc-offshore')` undercounted: VERIFIED 1,292 of the covered funds on a real sample day had
// data_provider = NULL (not one of those 3 labels) yet still had real fund_performances rows,
// which made coveragePct come out over 100%. COALESCE+NOT IN matches those NULL-provider funds too.
// 2026-10-18（第 3c 項）: 非核心（全部「非yahoo/SEC」基金，不限台灣買得到），改成只列數字
// 不標異常——核心母體覆蓋率看 checkCoreUniverseFundCoverage。
export async function checkFundPerformanceCoverage(query: QueryFn): Promise<CoverageResult> {
  return evaluateCoverage(query, "fund_performances", "fund_performances", "date", "fund_id",
    `SELECT COUNT(*)::int n FROM funds WHERE is_active = true AND COALESCE(data_provider, '') NOT IN ('yahoo', 'SEC')`, true);
}

// 2026-10-18 (使用者規則定案，第 2c 項): etf_history／fund_history 這兩張大表改用 LATERAL
// 「每檔取最新一筆」的查法，走 (id欄, date) 既有索引，不對整張表做 WHERE date = X 的全表掃描。
// 回傳「universe 裡有多少比例在最近 staleDaysThreshold 天內有資料」，不是「某個精確日期」的
// 覆蓋率（這兩張表橫跨太多市場/時區，沒有單一個「正確的那一天」）。
export async function checkHistoryFreshnessLateral(
  query: QueryFn,
  label: string,
  table: string,
  dateCol: string,
  idCol: string,
  universeTable: string,
  universeWhereSql: string,
  staleDaysThreshold: number,
  suppressAnomaly = false,
): Promise<CoverageResult> {
  const rows = await query(
    `SELECT
       COUNT(*) FILTER (WHERE latest.d >= CURRENT_DATE - $1::int)::int AS fresh,
       COUNT(*)::int AS universe
     FROM ${universeTable} u
     CROSS JOIN LATERAL (SELECT ${dateCol} AS d FROM ${table} h WHERE h.${idCol} = u.id ORDER BY h.${dateCol} DESC LIMIT 1) latest
     WHERE ${universeWhereSql}`,
    [staleDaysThreshold],
  );
  const universeCount = Number(rows[0]?.universe ?? 0);
  const coveredCount = Number(rows[0]?.fresh ?? 0);
  if (universeCount === 0) return { label, universeCount: 0, latestDate: null, coveredCount: 0, coveragePct: null, missingSample: [], anomaly: false, anomalyReason: null, baselineMethod: "LATERAL_FRESHNESS_WINDOW" };
  const coveragePct = (coveredCount / universeCount) * 100;
  const anomaly = !suppressAnomaly && coveragePct < 100;
  return { label, universeCount, latestDate: null, coveredCount, coveragePct, missingSample: [], anomaly, anomalyReason: anomaly ? `COVERAGE_${coveragePct.toFixed(1)}PCT` : null, baselineMethod: "LATERAL_FRESHNESS_WINDOW" };
}

// 2026-10-18（使用者規則定案，第 3c 項）: 「核心母體」覆蓋率——只算 tw_purchasable_classification
// 裡 status='APPROVED' 的資產（台灣買得到的 4 類：境內基金／境外基金／TWSE+TPEx ETF／美股ETF），
// 目標 100%。母體目前可能是 0（TW_PURCHASABLE_CLASSIFY 寫入開關還沒打開，或還沒跑過一次），
// 這種情況回報「universe empty」而不是誤判成異常。
export async function checkCoreUniverseEtfCoverage(query: QueryFn, staleDaysThreshold: number): Promise<CoverageResult> {
  return checkHistoryFreshnessLateral(
    query, "core_universe_etf", "etf_history", "date", "etf_id",
    `(SELECT asset_id AS id FROM tw_purchasable_classification WHERE asset_type = 'ETF' AND status = 'APPROVED')`,
    "true", staleDaysThreshold,
  );
}
// 2026-10-19（使用者核准，「提出讓它們退出核心母體的判斷規則」）: 部分已核備、理論上「核准
// 可銷售」的境外基金，實際上因為市場本身被凍結（VERIFIED 俄羅斯相關基金的 funds.latest_nav_date
// 本身——不是我們自己同步落後，是 TDCC 原始資料本身——卡在 2022 年沒再更新過，對應俄烏戰爭後
// 俄羅斯市場交易中斷），不是排程漏抓，是來源本身沒有新資料可抓。用 funds.latest_nav_date（官方
// 發布的淨值日期本身，不是我方抓取時間）超過 180 天沒更新當判斷依據：這代表 TDCC 自己的每日
// NAV 來源都已經很久沒有這檔基金的新資料，不只是我方排程的問題，不計入核心母體覆蓋率的分母。
// 門檻刻意設得保守（180 天，遠超過任何正常市場的連假/假日），避免誤殺真正只是偶爾清淡交易、
// 排程還在正常追的基金。
const FROZEN_FUND_STALE_DAYS = 180;

export async function checkCoreUniverseFundCoverage(query: QueryFn, staleDaysThreshold: number): Promise<CoverageResult> {
  return checkHistoryFreshnessLateral(
    query, "core_universe_fund", "fund_history", "date", "fund_id",
    `(SELECT c.asset_id AS id FROM tw_purchasable_classification c
        JOIN funds f ON f.id = c.asset_id
       WHERE c.asset_type = 'FUND' AND c.status = 'APPROVED'
         AND (f.latest_nav_date IS NULL OR f.latest_nav_date >= CURRENT_DATE - ${FROZEN_FUND_STALE_DAYS}))`,
    "true", staleDaysThreshold,
  );
}

// etf_history (1,836 萬筆) -- universe = 全部 active ETF，4 天內有新資料才算 fresh（跟既有
// evaluateFreshness 的 tw_stock_price/domestic_fund_nav 用同一個寬鬆門檻慣例）。
// 2026-10-18（第 3c 項）: 這是「非核心」（全部 active 資產，不限台灣買得到）的覆蓋率——改成
// suppressAnomaly=true，只列出數字供參考，不再標記異常。真正要達到 100% 目標、會觸發異常的
// 是上面的 checkCoreUniverseEtfCoverage/checkCoreUniverseFundCoverage（只算核心母體）。
export async function checkEtfHistoryFreshness(query: QueryFn): Promise<CoverageResult> {
  return checkHistoryFreshnessLateral(query, "etf_history", "etf_history", "date", "etf_id", "etfs", "u.is_active = true AND u.data_source IS NOT NULL", 4, true);
}

// fund_history (8,487 萬筆) -- 只檢查 yahoo-provider 基金（它們的報酬率只存在這張表，不是
// fund_performances，見上方說明），universe = 23,053 檔 yahoo-provider active fund。非核心，
// 同上不標異常。
export async function checkFundHistoryFreshness(query: QueryFn): Promise<CoverageResult> {
  return checkHistoryFreshnessLateral(query, "fund_history_yahoo", "fund_history", "date", "fund_id", "funds", "u.is_active = true AND u.data_source IS NOT NULL AND u.data_provider = 'yahoo'", 4, true);
}

// etf_performances -- small table (119k rows, safe to scan). Universe is intentionally the FULL
// active-ETF set here (not narrowed to TW/TWO), since this table is fed by multiple jobs
// (market-close-sync, etf-returns-sync, etf-returns-sync-tw) whose combined coverage is what
// actually matters to anyone reading return_1d -- this check is data-outcome-based, not tied to one
// job_id, same convention as the existing domestic_fund_nav freshness check below.
// 2026-10-18（第 3c 項）: 非核心（全部 active ETF，不限台灣買得到），只列數字不標異常。
export async function checkEtfPerformanceCoverage(query: QueryFn): Promise<CoverageResult> {
  return evaluateCoverage(query, "etf_performances", "etf_performances", "date", "etf_id", `SELECT COUNT(*)::int n FROM etfs WHERE is_active = true`, true);
}

export type YahooTwReturnSample = {
  code: string;
  ourReturn1y: number | null;
  yahooTwReturn1y: number | null; // null when the fetch itself failed/was rate-limited
  fetchFailed: boolean;
};

export type YahooTwReturnCheckResult = {
  samples: YahooTwReturnSample[];
  /** Any sample whose |diff| exceeds this, or whose fetch failed, is flagged. */
  mismatches: Array<YahooTwReturnSample & { diff: number | null }>;
  anomaly: boolean;
};

// Per docs/specs/yahoo-return-discrepancy.md: our stored return_1y (Yahoo global API) and Yahoo奇摩's
// own displayed value are known to NOT always agree exactly (different basis date, NAV- vs
// price-based calculation) -- a few points of drift is expected, not an anomaly. This threshold is
// for catching a REAL regression (e.g. the parser breaking after a Yahoo奇摩 page redesign, or a
// figure suddenly off by tens of points), not for chasing exact equality with a source that this
// project's own investigation found is never going to match exactly.
const MISMATCH_THRESHOLD_PCT_POINTS = 15;

export function evaluateYahooTwReturnConsistency(samples: YahooTwReturnSample[]): YahooTwReturnCheckResult {
  const mismatches = samples
    .map((s) => ({ ...s, diff: s.ourReturn1y != null && s.yahooTwReturn1y != null ? Math.abs(s.ourReturn1y - s.yahooTwReturn1y) : null }))
    .filter((s) => s.fetchFailed || s.diff === null || s.diff > MISMATCH_THRESHOLD_PCT_POINTS);
  return { samples, mismatches, anomaly: mismatches.length > 0 };
}

export type FredCommoditySample = {
  label: "WTI_CRUDE" | "NATURAL_GAS";
  ourSymbol: string; // our Yahoo root's symbol, e.g. "CL=F"
  ourDate: string | null;
  ourClose: number | null;
  fredSeriesId: string;
  fredDate: string | null;
  fredValue: number | null;
  fetchFailed: boolean;
};
export type FredCommodityCheckResult = {
  samples: FredCommoditySample[];
  mismatches: Array<FredCommoditySample & { diffPct: number | null }>;
  anomaly: boolean;
};

// Weekend list item 6: daily cross-check of our Yahoo-sourced WTI/Natural Gas closes against FRED's
// own published spot series (DCOILWTICO = WTI Cushing OK spot, DHHNGSP = Henry Hub spot). These are
// NOT the same instrument as our Yahoo CL=F/NG=F (front-month CONTINUOUS FUTURES, not cash spot), so
// some everyday basis/contango spread is normal and expected -- this is not meant to chase exact
// equality. VERIFIED live 2026-10-14 sample: WTI futures vs FRED spot diverged ~7.2% (95.09 vs
// 101.91), natural gas ~0.7% (3.198 vs 3.22) -- thresholds below are set above that observed normal
// spread so this only fires on a genuinely abnormal divergence (a stale/broken feed on either side,
// or a real market dislocation worth a human look), not routine futures-vs-spot basis.
const FRED_MISMATCH_THRESHOLD_PCT = { WTI_CRUDE: 12, NATURAL_GAS: 15 } as const;

export function evaluateFredCommodityConsistency(samples: FredCommoditySample[]): FredCommodityCheckResult {
  const mismatches = samples
    .map((s) => ({
      ...s,
      diffPct: s.ourClose != null && s.fredValue != null && s.fredValue !== 0
        ? Math.abs((s.ourClose - s.fredValue) / s.fredValue) * 100
        : null,
    }))
    .filter((s) => s.fetchFailed || s.diffPct === null || s.diffPct > FRED_MISMATCH_THRESHOLD_PCT[s.label]);
  return { samples, mismatches, anomaly: mismatches.length > 0 };
}
