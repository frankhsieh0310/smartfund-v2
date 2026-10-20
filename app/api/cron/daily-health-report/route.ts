// Daily 08:30 Taipei health check across all six domestic/cloud pipelines this session built or
// touched: market-close-sync, etf-returns-sync, us-fund-nav-sync, sitca-nav-sync, offshore-nav-sync
// (all logged via production_scheduler_runs in THIS database), and tw-data-updater's institutional
// data (also logged here, in the same shared Postgres, since today's fix added run-logging there) and
// stock price data (NOT logged anywhere -- tw-data-updater's price-update.js never wrote to
// production_scheduler_runs; checked via stock_history freshness instead, the only signal available).
//
// Read-only: every check is a SELECT. The only write is the route's own run-log entry (finishRun),
// same existing table every other pipeline already uses -- no new table, no write to any business
// data table. Notification only fires on anomaly (lib/daily-health-report/notify.ts); a clean day
// writes the run log and returns, nothing else.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { checkPipelineRunLog, checkMoneydjParseFailures, evaluateFreshness, checkEtfDataSourceGap, evaluateYahooTwReturnConsistency, evaluateFredCommodityConsistency, checkCommodityTechnicalCoverage, checkFundPerformanceCoverage, checkEtfPerformanceCoverage, checkEtfHistoryFreshness, checkFundHistoryFreshness, checkCoreUniverseEtfCoverage, checkCoreUniverseFundCoverage, checkActiveEtfOfficialHoldingsCoverage, type QueryFn, type YahooTwReturnSample, type FredCommoditySample } from "@/lib/daily-health-report/checks";
import { CORE_COMMODITY_ROOTS } from "@/lib/cron/commodityUpdate";
import { notifyAnomaly } from "@/lib/daily-health-report/notify";
import { buildDailySummary } from "@/lib/daily-health-report/buildDailySummary";
import { fetchYahooTwPerformance } from "@/lib/yahoo/twPerformancePage";

export const runtime = "nodejs";
// 2026-10-20: raised from 60s after a real Vercel Runtime Timeout killed this route mid-run
// (production_scheduler_runs left a permanently-stuck IN_PROGRESS row, no finishRun ever reached --
// see YAHOO_TW_CHECK_MAX_ELAPSED_MS below for the actual root cause and the matching bail-out guard).
export const maxDuration = 180;
export const dynamic = "force-dynamic";
// Wall-clock cutoff (elapsed since route start) for the Yahoo奇摩 consistency loop below: each sample
// can take up to a 15s fetch timeout (fetchYahooTwPerformance) plus a mandatory 3.2s courtesy delay --
// 3 samples worst case is ~54.6s, which is almost exactly what pushed 2026-10-19's run to 54s and
// 2026-10-20's run past the old 60s maxDuration entirely (confirmed via Vercel's own "Task timed out
// after 60 seconds" log for that invocation -- the run never reached finishRun, so the stuck row never
// recorded an anomaly list at all, not even a real "0 anomalies" result). The loop now checks this
// before starting each sample and stops early once it's spent too long already (recording any
// remaining samples as fetchFailed, never fabricated), so a slow/rate-limited Yahoo day degrades this
// one check instead of risking the whole route again even at the new, larger maxDuration.
const YAHOO_TW_CHECK_MAX_ELAPSED_MS = 40_000;

const JOB = "DAILY_HEALTH_REPORT";
const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

// Pipelines logged in THIS database's production_scheduler_runs (smartfund-v2's own crons, plus
// tw-data-updater's institutional-update which shares this same Postgres and started logging here
// as of today's fix).
//
// 2026-10-18 (使用者規則定案，第 2a 項): 原本的清單只有 6 支，這次排程耗時稽核找到的 11 支
// 風險排程（CLOUD_ETF_PRICE、CLOUD_FUND_NAV:SITCA、CLOUD_MONEYDJ_FUND、FUND_RETURNS_SYNC、
// TW_ETF_DAY_CHANGE、YAHOO_ETF_FULL_SWEEP、YAHOO_FUND_FULL_SWEEP、YAHOO_COMMODITY_TECHNICAL、
// HOLDINGS_ALT_SOURCE_SYNC、CLOUD_SEC_FINANCIAL_INCREMENTAL、CLOUD_CONSENSUS_INGEST）一個都不在
// 裡面——代表這些排程完全停擺，健康報告都不會發現。另外追查 TW ETF 覆蓋率時又多發現一支
// ETF_RETURNS_SYNC_TW 也沒被監控，一起加進來。CLOUD_FUND_NAV 的 job_id 實際帶 provider 後綴
// （見 beginRun 的 runKey 慣例），這裡用前綴比對，checkPipelineRunLog 內部若查不到完全比對的
// job_id 會回報 NO_RUN_IN_LAST_24H，之後如有需要可以再改成前綴查詢。
const RUN_LOG_PIPELINES = [
  "MARKET_CLOSE_SYNC_SHADOW",
  "ETF_RETURNS_SYNC",
  "ETF_RETURNS_SYNC_TW",
  "US_FUND_NAV_SYNC",
  "SITCA_NAV_SYNC",
  "OFFSHORE_NAV_SYNC",
  "INSTITUTIONAL_UPDATE",
  "CLOUD_ETF_PRICE",
  "CLOUD_FUND_NAV:SITCA",
  "CLOUD_MONEYDJ_FUND",
  "FUND_RETURNS_SYNC",
  "TW_ETF_DAY_CHANGE",
  "YAHOO_ETF_FULL_SWEEP",
  "YAHOO_FUND_FULL_SWEEP",
  "YAHOO_COMMODITY_TECHNICAL",
  "HOLDINGS_ALT_SOURCE_SYNC",
  "CLOUD_SEC_FINANCIAL_INCREMENTAL",
  "CLOUD_CONSENSUS_INGEST",
  "TW_PURCHASABLE_CLASSIFY",
];

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const runKey = `daily-health-report:${today}`;

  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "INTERNAL_HEALTH_CHECK", runKey,
    universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "already ran today", runKey });
  }

  const pipelineHealth = await Promise.all(RUN_LOG_PIPELINES.map((j) => checkPipelineRunLog(query, j)));

  // 2026-10-19（使用者核准）: checkPipelineRunLog's benign-error check only ever looks at the first
  // sampled failure per run; this reads the full sample_failures array across the 24h window and
  // lists the ACTUAL fund codes behind any real (non-benign) MoneyDJ parse failure, per the user's
  // explicit requirement -- "其他解析不到的，一律算異常並列出代號".
  const moneydjParseFailures = await checkMoneydjParseFailures(query);

  // tw-data-updater's stock price pipeline has no run-log signal (its crons never wrote to this
  // table) -- the only available signal is data freshness itself, checked loosely (not a full
  // trading-calendar lookup, documented in checks.ts).
  const stockFreshRow = await prisma.$queryRawUnsafe<Array<{ max_date: string | null }>>(
    `SELECT to_char(max(date), 'YYYY-MM-DD') AS max_date FROM stock_history WHERE stock_id IN (SELECT id FROM stocks WHERE country = 'TW' LIMIT 200)`,
  );
  const stockFreshness = evaluateFreshness("tw_stock_price", stockFreshRow[0]?.max_date ?? null, 4);

  const domesticFundFreshRow = await prisma.$queryRawUnsafe<Array<{ max_date: string | null }>>(
    `SELECT to_char(max(latest_nav_date), 'YYYY-MM-DD') AS max_date FROM funds WHERE COALESCE(data_provider, '') NOT IN ('yahoo', 'SEC')`,
  );
  const domesticFundFreshness = evaluateFreshness("domestic_fund_nav", domesticFundFreshRow[0]?.max_date ?? null, 4);

  // 2026-10-18 (使用者規則定案，第 2b 項): 判斷依據從「排程有沒有報錯」改成「母體裡真的有
  //多少比例在最近一個更新日拿到資料」。只挑小表（fund_performances/etf_performances/
  // futures_technical_analytics）——etf_history／fund_history 這兩張大表故意沒做，見
  // checks.ts 裡 evaluateCoverage 的註解說明為什麼。
  const coreRootIds = CORE_COMMODITY_ROOTS.map((r) => r.rootId);
  // 2026-10-18（第 3c 項）: 新增「核心母體」覆蓋率——只算 tw_purchasable_classification 裡
  // status='APPROVED' 的資產，目標 100%、未達標會標異常；原本的 4 項全部改成非核心（已經在
  // checks.ts 裡用 suppressAnomaly=true），只列數字參考，不再觸發異常。
  const [fundPerformanceCoverage, etfPerformanceCoverage, commodityTechnicalCoverage, etfHistoryFreshness, fundHistoryFreshness, coreUniverseEtfCoverage, coreUniverseFundCoverage] = await Promise.all([
    checkFundPerformanceCoverage(query),
    checkEtfPerformanceCoverage(query),
    checkCommodityTechnicalCoverage(query, coreRootIds),
    checkEtfHistoryFreshness(query),
    checkFundHistoryFreshness(query),
    checkCoreUniverseEtfCoverage(query, 4),
    checkCoreUniverseFundCoverage(query, 4),
  ]);
  const coverage = [fundPerformanceCoverage, etfPerformanceCoverage, commodityTechnicalCoverage, etfHistoryFreshness, fundHistoryFreshness, coreUniverseEtfCoverage, coreUniverseFundCoverage];
  const etfDataSourceGap = await checkEtfDataSourceGap(query);
  const activeEtfOfficialHoldings = await checkActiveEtfOfficialHoldingsCoverage(query, 4);

  // 2026-10-13 QA-round-1 addition: 3 random TWD-listed ETFs, our stored return_1y vs Yahoo奇摩's own
  // displayed value (docs/specs/yahoo-return-discrepancy.md) -- catches a parser regression (e.g. a
  // Yahoo奇摩 page redesign) or a sudden, large data error, not the few-point drift that's expected
  // and already documented. Requests are sequential with a 3s+ gap (same courtesy as the offshore NAV
  // fetcher) and a 401/403/429 aborts the remaining samples for today rather than hammering Yahoo.
  const sampleRows = await prisma.$queryRawUnsafe<Array<{ code: string; data_source: string; return_1y: number | null }>>(
    `SELECT code, data_source, return_1y FROM etfs WHERE is_active = true AND currency = 'TWD' AND data_source IS NOT NULL ORDER BY random() LIMIT 3`,
  );
  const yahooTwSamples: YahooTwReturnSample[] = [];
  for (const row of sampleRows) {
    if (Date.now() - startedMs > YAHOO_TW_CHECK_MAX_ELAPSED_MS) {
      yahooTwSamples.push({ code: row.code, ourReturn1y: row.return_1y, yahooTwReturn1y: null, fetchFailed: true });
      break; // already spent too long on this check this run -- stop before risking the whole route
    }
    try {
      const perf = await fetchYahooTwPerformance(row.data_source);
      yahooTwSamples.push({ code: row.code, ourReturn1y: row.return_1y, yahooTwReturn1y: perf?.navReturn.y1 ?? null, fetchFailed: perf === null });
    } catch {
      yahooTwSamples.push({ code: row.code, ourReturn1y: row.return_1y, yahooTwReturn1y: null, fetchFailed: true });
      break; // rate-limited or similar -- stop hitting Yahoo for the rest of today's sample
    }
    await new Promise((r) => setTimeout(r, 3200));
  }
  const yahooTwCheck = evaluateYahooTwReturnConsistency(yahooTwSamples);

  // Weekend list item 6: cross-check our Yahoo-sourced WTI/Natural Gas closes against FRED's own
  // published spot series. FRED_API_KEY missing/misconfigured is itself treated as fetchFailed
  // (surfaced as an anomaly) rather than silently skipped -- a broken cross-check is worse than no
  // cross-check if it just goes quiet.
  const fredRoots: Array<{ label: FredCommoditySample["label"]; rootId: string; ourSymbol: string; fredSeriesId: string }> = [
    { label: "WTI_CRUDE", rootId: "ceebeb1f-3616-4d38-ab85-a7de76455d9a", ourSymbol: "CL=F", fredSeriesId: "DCOILWTICO" },
    { label: "NATURAL_GAS", rootId: "8c9966ab-8e29-43bc-a4ff-e908fef9b2c2", ourSymbol: "NG=F", fredSeriesId: "DHHNGSP" },
  ];
  const fredApiKey = process.env.FRED_API_KEY;
  const fredSamples: FredCommoditySample[] = await Promise.all(
    fredRoots.map(async (r): Promise<FredCommoditySample> => {
      const ourRow = (await prisma.$queryRawUnsafe<Array<{ observed_date: string; close: string }>>(
        `SELECT observed_date::text, close::text FROM futures_root_market_observations WHERE root_id = $1::uuid ORDER BY observed_date DESC LIMIT 1`,
        r.rootId,
      ))[0];
      const base = { label: r.label, ourSymbol: r.ourSymbol, fredSeriesId: r.fredSeriesId, ourDate: ourRow?.observed_date ?? null, ourClose: ourRow ? Number(ourRow.close) : null };
      if (!fredApiKey) return { ...base, fredDate: null, fredValue: null, fetchFailed: true };
      // 2026-10-19（使用者核准）: 抓取失敗時同一次執行內重試，最多 3 次、間隔遞增
      // （1s/2s/4s），降低外部 API 偶發性逾時/限流被誤判成「資料異常」的機率；3 次都失敗才
      // 真的記為 fetchFailed，報告裡會標明是外部來源問題，不是我方資料缺口。
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const url = new URL("https://api.stlouisfed.org/fred/series/observations");
          url.searchParams.set("series_id", r.fredSeriesId);
          url.searchParams.set("api_key", fredApiKey);
          url.searchParams.set("file_type", "json");
          url.searchParams.set("sort_order", "desc");
          url.searchParams.set("limit", "1");
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new Error(`FRED_HTTP_${res.status}`);
          const json = (await res.json()) as { observations?: Array<{ date: string; value: string }> };
          const obs = json.observations?.[0];
          const value = obs && obs.value !== "." ? Number(obs.value) : null;
          if (value === null) throw new Error("FRED_NO_VALUE");
          return { ...base, fredDate: obs?.date ?? null, fredValue: value, fetchFailed: false };
        } catch {
          if (attempt === MAX_ATTEMPTS) return { ...base, fredDate: null, fredValue: null, fetchFailed: true };
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
        }
      }
      return { ...base, fredDate: null, fredValue: null, fetchFailed: true };
    }),
  );
  const fredCommodityCheck = evaluateFredCommodityConsistency(fredSamples);

  // 2026-10-20（使用者訂立）: 每個異常都要分類成 SYSTEM（必須為 0）或 EXTERNAL_DELAY（只有
  // 在「實際查看來源網站、確認對方尚未公布」且附上查證時間與結果時才可以歸類，且只在分類當下
  // 真的做了這個查證）。目前沒有任何一種異常類型內建「自動查證來源網站、記錄查證時間與結果」
  // 的機制（BENIGN_ERROR_PATTERNS 那套只排除「來源明確回報沒有資料」這種已知良性錯誤，不等於
  // 「已查證是外部延遲」），所以依照使用者「不確定就一律算系統問題」的規則，這裡每一項都先標
  // SYSTEM——之後如果要讓某個檢查項目真正支援 EXTERNAL_DELAY，必須在那個檢查裡加上即時查證來源
  // 網站的程式碼，並把查證時間/結果一起寫進這個 category 欄位旁邊，不能只是改這裡的預設值。
  const SYSTEM_CATEGORY = "SYSTEM" as const;
  const anomalies = [
    ...pipelineHealth.filter((p) => p.anomaly).map((p) => ({ type: "PIPELINE", category: SYSTEM_CATEGORY, jobId: p.jobId, reasons: p.anomalyReasons })),
    ...[stockFreshness, domesticFundFreshness].filter((f) => f.anomaly).map((f) => ({ type: "FRESHNESS", category: SYSTEM_CATEGORY, label: f.label, reason: f.anomalyReason })),
    ...(etfDataSourceGap.anomaly ? [{ type: "ETF_DATA_SOURCE_GAP", category: SYSTEM_CATEGORY, newCodes: etfDataSourceGap.newCodes }] : []),
    ...(activeEtfOfficialHoldings.anomaly ? [{ type: "ACTIVE_ETF_OFFICIAL_HOLDINGS_GAP", category: SYSTEM_CATEGORY, missingOrStale: activeEtfOfficialHoldings.missingOrStale }] : []),
    ...(yahooTwCheck.anomaly ? [{ type: "YAHOO_TW_RETURN_MISMATCH", category: SYSTEM_CATEGORY, mismatches: yahooTwCheck.mismatches }] : []),
    ...(fredCommodityCheck.anomaly ? [{ type: "FRED_COMMODITY_MISMATCH", category: SYSTEM_CATEGORY, mismatches: fredCommodityCheck.mismatches }] : []),
    ...coverage.filter((c) => c.anomaly).map((c) => ({ type: "COVERAGE", category: SYSTEM_CATEGORY, label: c.label, reason: c.anomalyReason })),
    ...(moneydjParseFailures.parseFailedCount > 0
      ? [{ type: "MONEYDJ_PARSE_FAILED", category: SYSTEM_CATEGORY, jobId: "CLOUD_MONEYDJ_FUND", count: moneydjParseFailures.parseFailedCount, codes: moneydjParseFailures.parseFailedCodes }]
      : []),
    ...(moneydjParseFailures.nameOnlyCount > 0
      ? [{ type: "MONEYDJ_NAME_ONLY_NO_WEIGHT", category: SYSTEM_CATEGORY, jobId: "CLOUD_MONEYDJ_FUND", count: moneydjParseFailures.nameOnlyCount, codes: moneydjParseFailures.nameOnlyCodes }]
      : []),
  ];
  const systemAnomalyCount = anomalies.filter((a) => a.category === SYSTEM_CATEGORY).length;
  const externalDelayAnomalyCount = anomalies.length - systemAnomalyCount;

  // Round-4, user-approved: send a short summary EVERY day, not only when something is wrong --
  // "沒收到訊息就代表出事了" means silence itself must never be the normal case. See
  // buildDailySummary.ts for the message format (unit-tested separately).
  const summary = buildDailySummary({
    today, anomalyCount: anomalies.length, pipelineHealth,
    freshness: [stockFreshness, domesticFundFreshness], etfDataSourceGap, yahooTwCheck, fredCommodityCheck, coverage,
  });
  const notifyResult = await notifyAnomaly(summary);

  const status = anomalies.length > 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "INTERNAL_HEALTH_CHECK", startedMs, {
    status, attempted: RUN_LOG_PIPELINES.length + 4 + coverage.length, completed: RUN_LOG_PIPELINES.length + 4 + coverage.length - anomalies.length,
    inserted: 0, updated: 0, failed: anomalies.length, retryableFailures: 0, checkpointAfter: null,
    details: {
      date: today, pipeline_health: pipelineHealth, stock_freshness: stockFreshness, domestic_fund_freshness: domesticFundFreshness,
      etf_data_source_gap: etfDataSourceGap, yahoo_tw_return_check: yahooTwCheck, fred_commodity_check: fredCommodityCheck, coverage,
      active_etf_official_holdings: activeEtfOfficialHoldings,
      moneydj_parse_failures: moneydjParseFailures,
      anomaly_count: anomalies.length, system_anomaly_count: systemAnomalyCount, external_delay_anomaly_count: externalDelayAnomalyCount,
      anomalies, notify_result: notifyResult,
    },
  });

  return Response.json({ ok: true, job: JOB, runId, status, anomalyCount: anomalies.length, systemAnomalyCount, externalDelayAnomalyCount, anomalies, etfDataSourceGap, activeEtfOfficialHoldings, yahooTwCheck, fredCommodityCheck, coverage, notifyResult });
}
