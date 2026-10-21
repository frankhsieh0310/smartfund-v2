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
import { checkPipelineRunLog, checkMoneydjParseFailures, evaluateFreshness, checkEtfDataSourceGap, evaluateYahooTwReturnConsistency, evaluateFredCommodityConsistency, checkCommodityTechnicalCoverage, checkFundPerformanceCoverage, checkEtfPerformanceCoverage, checkEtfHistoryFreshness, checkFundHistoryFreshness, checkCoreUniverseEtfCoverage, checkCoreUniverseFundCoverage, checkCoreUniverseFundGapDetail, checkCoreUniverseEtfGapDetail, checkActiveEtfOfficialHoldingsCoverage, checkLocalScheduleReporting, type QueryFn, type YahooTwReturnSample, type FredCommoditySample } from "@/lib/daily-health-report/checks";
import { fetchYahooChartPeriod } from "@/lib/services/dataProviders/yahoo/yahooClient";
import { CORE_COMMODITY_ROOTS } from "@/lib/cron/commodityUpdate";
import { notifyAnomaly } from "@/lib/daily-health-report/notify";
import { buildDailySummary } from "@/lib/daily-health-report/buildDailySummary";
import { fetchYahooTwPerformance } from "@/lib/yahoo/twPerformancePage";
import { AllianzOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/allianz";
import { FhtOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/fht";
import { AbOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/ab";
import { CtbcOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/ctbc";
import { BlackRockOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/blackrock";
import { FubonOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/fubon";
import { UpamcOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/upamc";
import { YuantaOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/yuanta";
import { CapitalOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/capital";
import { CathayOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/cathay";
import { JpmorganOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/jpmorgan";
import { KgiOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/kgi";
import { FirstOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/first";
import { SinoPacOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/sinopac";
import { TaishinOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/taishin";
import { NomuraOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/nomura";
import type { OfficialPcfAdapter } from "@/lib/etf-holdings-engine/types";

// 2026-10-20（使用者訂立）: EXTERNAL_DELAY 分類的查證機制。這個 map 讓健康報告能對缺資料的主動式
// ETF 直接呼叫該投信的官方 adapter 即時查一次，記下「官網當下顯示的最新資料日期」與「查詢時間」
// 當證據——跟 etf-official-holdings route.ts 裡 getIssuerUniverse 用同一套品牌關鍵字對應表，兩邊
// 保持一致。
const ACTIVE_ETF_ADAPTER_BY_KEYWORD: Array<{ keyword: string; adapter: OfficialPcfAdapter }> = [
  { keyword: "國泰", adapter: CathayOfficialPcfAdapter }, { keyword: "摩根", adapter: JpmorganOfficialPcfAdapter },
  { keyword: "安聯", adapter: AllianzOfficialPcfAdapter }, { keyword: "統一", adapter: UpamcOfficialPcfAdapter },
  { keyword: "聯博", adapter: AbOfficialPcfAdapter }, { keyword: "富邦", adapter: FubonOfficialPcfAdapter },
  { keyword: "中信", adapter: CtbcOfficialPcfAdapter }, { keyword: "凱基", adapter: KgiOfficialPcfAdapter },
  { keyword: "第一金", adapter: FirstOfficialPcfAdapter }, { keyword: "復華", adapter: FhtOfficialPcfAdapter },
  { keyword: "永豐", adapter: SinoPacOfficialPcfAdapter }, { keyword: "元大", adapter: YuantaOfficialPcfAdapter },
  { keyword: "群益", adapter: CapitalOfficialPcfAdapter }, { keyword: "台新", adapter: TaishinOfficialPcfAdapter },
  { keyword: "野村", adapter: NomuraOfficialPcfAdapter }, { keyword: "貝萊德", adapter: BlackRockOfficialPcfAdapter },
];
function resolveActiveEtfAdapter(name: string, provider: string): OfficialPcfAdapter | null {
  const hit = ACTIVE_ETF_ADAPTER_BY_KEYWORD.find((e) => name.includes(e.keyword) || provider.includes(e.keyword));
  return hit?.adapter ?? null;
}
// Bounded, best-effort: at most this many of the flagged gap tickers get a LIVE re-check per run (each
// one is a real external HTTP call to that issuer's own site), and the whole step gives up once this
// much wall-clock time has passed since route start -- same discipline as YAHOO_TW_CHECK_MAX_ELAPSED_MS
// above, so this new step can never itself reproduce the 2026-10-20 timeout. Anything not actually
// re-checked (skipped for budget, or the live call itself fails) stays SYSTEM by the default rule
// below -- EXTERNAL_DELAY is only ever assigned when a fresh, timestamped probe against the issuer's
// own site actually confirms its own latest date is still old.
const ACTIVE_ETF_VERIFY_MAX_ITEMS = 5;
const ACTIVE_ETF_VERIFY_MAX_ELAPSED_MS = 100_000;

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
  const localScheduleReporting = await checkLocalScheduleReporting(query);

  // 2026-10-21（使用者核准）: core_universe_fund 覆蓋率缺口的證據分類——VERIFIED 直接查證過：
  // 1) null-provider／SITCA 這兩類的缺口，SITCA_NAV_SYNC 本身已經是即時查 DB（不是靠名單，見
  //    checks.ts 註解），不是名單問題；真正根因要看 SITCA 官方 CSV 當天到底公布了什麼。
  // 2) tdcc-offshore 這一類才是真正的「名單」問題（offshore-nav-sync 的 mapping 是 2026-10-12
  //    的一次性清單，見 discoverMapping.ts），已經用自我擴充機制修好，這裡不用再查證據——新
  //    發現的對應關係會在下一輪 offshore-nav-sync 執行時自動補上。
  // 一次性抓 SITCA 公開 CSV（不需要金鑰、不是逐檔查詢），對缺口裡的 null-provider/SITCA 基金用
  // 基金統編（=funds.code）比對：CSV 裡這個代號的淨值欄位是 "-"（已存在但還沒公布首次淨值）才算
  // EXTERNAL_DELAY；代號完全不在 CSV 裡、但本方資料庫顯示先前有過真實淨值（代表來源端可能暫停
  // 這檔的淨值公告）也算 EXTERNAL_DELAY，附上「查詢時間＋先前最後淨值日期」當證據；代號在 CSV
  // 裡有真實數值、我方卻沒寫入，才是真正的 SYSTEM 問題（我方排程/比對邏輯有缺口，需要另外查）。
  const coreUniverseFundGapRows = await checkCoreUniverseFundGapDetail(query, 4);
  const coreUniverseFundGapWithEvidence: Array<{
    code: string | null; name: string; dataProvider: string | null;
    category: "SYSTEM" | "EXTERNAL_DELAY"; reason: string; checkedAt: string;
  }> = [];
  // 2026-10-21（使用者核准）: a fund still approved for sale (confirmed via the official source)
  // whose share class has NEVER had a NAV published at all (latestNavDate IS NULL -- not "reported
  // before, now stale") is its own category, not a daily-recurring EXTERNAL_DELAY anomaly. VERIFIED
  // live: MGF35/MGF38 (hongleong Dragon Growth/India Equity I-acc) and the Russia/UEAHAA pair, plus
  // 11 SITCA domestic share classes, all still show up in TDCC/SITCA's own "approved for sale"
  // dataset today with zero NAV ever published. Counted here, surfaced once as a count
  // (details.core_universe_fund_never_reported_count), and excluded from the anomaly list entirely.
  const coreUniverseFundNeverReported: Array<{ code: string | null; name: string; dataProvider: string | null }> = [];
  {
    const checkedAt = new Date().toISOString();
    let sitcaCsvRows: string[][] | null = null;
    let sitcaFetchError: string | null = null;
    try {
      const res = await fetch("https://www.sitca.org.tw/MemberK0000/F/03/nav.csv", { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`SITCA_CSV_HTTP_${res.status}`);
      const text = await res.text();
      sitcaCsvRows = text.split("\n").map((l) => l.split(","));
    } catch (e) {
      sitcaFetchError = e instanceof Error ? e.message : String(e);
    }
    const sitcaByCode = new Map<string, string>(); // code -> nav string ("-" means not yet published)
    if (sitcaCsvRows) for (const cols of sitcaCsvRows) if (cols.length >= 7 && cols[3]) sitcaByCode.set(cols[3], cols[6]);

    for (const fund of coreUniverseFundGapRows) {
      if (fund.dataProvider === "tdcc-offshore") continue; // handled separately below (TDCC source, not SITCA)
      if (!sitcaCsvRows) {
        coreUniverseFundGapWithEvidence.push({ code: fund.code, name: fund.name, dataProvider: fund.dataProvider, category: "SYSTEM", reason: `SITCA_CSV_FETCH_FAILED: ${sitcaFetchError}`, checkedAt });
        continue;
      }
      const csvNav = fund.code ? sitcaByCode.get(fund.code) : undefined;
      if (csvNav === "-" || csvNav === "") {
        if (fund.latestNavDate === null) {
          coreUniverseFundNeverReported.push({ code: fund.code, name: fund.name, dataProvider: fund.dataProvider });
        } else {
          coreUniverseFundGapWithEvidence.push({ code: fund.code, name: fund.name, dataProvider: fund.dataProvider, category: "EXTERNAL_DELAY", reason: "SITCA_LISTED_NAV_NOT_YET_PUBLISHED", checkedAt });
        }
      } else if (csvNav === undefined) {
        coreUniverseFundGapWithEvidence.push({ code: fund.code, name: fund.name, dataProvider: fund.dataProvider, category: "EXTERNAL_DELAY", reason: "ABSENT_FROM_TODAYS_SITCA_CSV_DESPITE_PRIOR_REAL_NAV", checkedAt });
      } else {
        coreUniverseFundGapWithEvidence.push({ code: fund.code, name: fund.name, dataProvider: fund.dataProvider, category: "SYSTEM", reason: `SITCA_HAS_REAL_NAV_${csvNav}_NOT_INGESTED`, checkedAt });
      }
    }

    // tdcc-offshore: a fund with latestNavDate=null is either never-reported (if TDCC's own NAV
    // dataset 3-4 has no valid row for it at all, confirmed live for the Russia/UEAHAA pair and
    // MGF35/MGF38 -- see CLAUDE.md for the full investigation) or just hasn't been resolved by the
    // self-extending mapping yet (regular EXTERNAL_DELAY/SYSTEM territory, already handled by that
    // fix). Only the confirmed-never-reported ones are pulled out here; everything else for
    // tdcc-offshore stays un-evidence-checked as before (self-extending mapping handles the gap).
    const tdccNeverReportedCandidates = coreUniverseFundGapRows.filter((f) => f.dataProvider === "tdcc-offshore" && f.latestNavDate === null);
    if (tdccNeverReportedCandidates.length > 0) {
      try {
        const res = await fetch("https://opendata.tdcc.com.tw/getOD.ashx?id=3-4", { signal: AbortSignal.timeout(20_000) });
        if (res.ok) {
          const text = await res.text();
          const codesInNav = new Set<string>();
          const namesInNav = new Set<string>();
          for (const line of text.split("\n")) {
            const p = line.trim().split(",");
            if (p.length < 6) continue;
            if (p[0]) codesInNav.add(p[0]);
            if (p[1]) namesInNav.add(p[1]);
          }
          for (const fund of tdccNeverReportedCandidates) {
            const inNav = fund.code ? codesInNav.has(fund.code) : namesInNav.has(fund.name);
            if (!inNav) coreUniverseFundNeverReported.push({ code: fund.code, name: fund.name, dataProvider: fund.dataProvider });
          }
        }
      } catch {
        // best-effort only -- these funds just stay out of coreUniverseFundNeverReported this run,
        // picked up again next time; never blocks the rest of the report.
      }
    }
  }

  // 2026-10-21（使用者核准）: core_universe_etf 15 檔缺口（今天查時剩 13 檔）——VERIFIED 逐檔直接
  // 打 Yahoo Chart API 查證，全部是美股/那斯達克上市的小型主題型 ETF（ProShares、Bitwise、
  // American Century 等發行的冷門主題基金），Yahoo 自己對這些近期交易日的資料也是 null 或完全
  // 查無結果（量太小、Yahoo 自己資料就缺），不是我方排程的 bug。跟上面 core_universe_fund 同一套
  // 證據紀律：用同一支 fetchYahooChartPeriod（CLOUD_ETF_PRICE 用的那支），只查最近 5 天，Yahoo
  // 回應裡最後一筆有收盤價就算「來源端其實有資料、我方沒抓到」=SYSTEM；Yahoo 本身也查不到/全是
  // null 才算 EXTERNAL_DELAY。有界：最多查 8 檔、最多花 30 秒。
  const coreUniverseEtfGapRows = await checkCoreUniverseEtfGapDetail(query, 4);
  const CORE_ETF_GAP_VERIFY_MAX_ITEMS = 8;
  const CORE_ETF_GAP_VERIFY_MAX_ELAPSED_MS = 20_000;
  const coreUniverseEtfGapWithEvidence: Array<{
    code: string; name: string; category: "SYSTEM" | "EXTERNAL_DELAY"; reason: string; checkedAt: string;
  }> = [];
  {
    const verifyStartedMs = Date.now();
    for (const etf of coreUniverseEtfGapRows) {
      const checkedAt = new Date().toISOString();
      // Bounded against BOTH this check's own small slice (CORE_ETF_GAP_VERIFY_MAX_ELAPSED_MS) AND
      // the overall route clock (startedMs) -- this check runs before the existing active-ETF (100s)
      // and Yahoo-TW (40s) budgets, which are themselves measured from the same startedMs and will
      // adapt downward automatically, but this guard keeps this check itself from being the one that
      // eats into maxDuration=180 if a slow Yahoo response stalls it.
      if (coreUniverseEtfGapWithEvidence.length >= CORE_ETF_GAP_VERIFY_MAX_ITEMS || Date.now() - verifyStartedMs > CORE_ETF_GAP_VERIFY_MAX_ELAPSED_MS || Date.now() - startedMs > 120_000) {
        coreUniverseEtfGapWithEvidence.push({ code: etf.code, name: etf.name, category: "SYSTEM", reason: "NOT_VERIFIED_BUDGET_EXHAUSTED", checkedAt });
        continue;
      }
      try {
        const symbol = etf.dataSource ?? etf.code;
        const period2 = Math.floor(Date.now() / 1000);
        const period1 = period2 - 5 * 24 * 60 * 60;
        const chart = await fetchYahooChartPeriod(symbol, period1, period2);
        const latestRealClose = chart?.candles.filter((c) => c.close != null).at(-1);
        if (latestRealClose) {
          coreUniverseEtfGapWithEvidence.push({ code: etf.code, name: etf.name, category: "SYSTEM", reason: `YAHOO_HAS_DATA_AS_OF_${latestRealClose.date.toISOString().slice(0, 10)}_NOT_INGESTED`, checkedAt });
        } else {
          coreUniverseEtfGapWithEvidence.push({ code: etf.code, name: etf.name, category: "EXTERNAL_DELAY", reason: chart ? "YAHOO_RETURNED_NO_REAL_CLOSE_IN_LAST_5D" : "YAHOO_CHART_NULL", checkedAt });
        }
      } catch (e) {
        coreUniverseEtfGapWithEvidence.push({ code: etf.code, name: etf.name, category: "SYSTEM", reason: `VERIFY_FAILED: ${e instanceof Error ? e.message : String(e)}`, checkedAt });
      }
    }
  }

  // 2026-10-20（使用者訂立）: 對缺資料/過期的主動式 ETF，即時打一次該投信官網，記錄「官網當下
  // 顯示的最新資料日期」跟「查詢時間」當證據——只有官網自己的最新日期確實還是舊的，才能標
  // EXTERNAL_DELAY；查不到、查詢本身失敗、或官網其實已經有更新資料（代表是我方排程沒抓到），
  // 一律維持 SYSTEM（預設值，不確定就算系統問題）。有界：最多查 5 檔、最多花 100 秒，避免這個
  //新步驟自己又把整個路由拖到逾時（同一套紀律跟上面的 YAHOO_TW_CHECK_MAX_ELAPSED_MS 一樣）。
  const activeEtfGapWithEvidence: Array<{
    code: string; name: string; provider: string; lastDataDate: string | null;
    category: "SYSTEM" | "EXTERNAL_DELAY"; checkedAt?: string; officialLatestDate?: string | null; verifyNote?: string;
  }> = [];
  for (const item of activeEtfOfficialHoldings.missingOrStale) {
    const idx = activeEtfGapWithEvidence.length;
    if (idx >= ACTIVE_ETF_VERIFY_MAX_ITEMS || Date.now() - startedMs > ACTIVE_ETF_VERIFY_MAX_ELAPSED_MS) {
      activeEtfGapWithEvidence.push({ ...item, category: "SYSTEM", verifyNote: "NOT_VERIFIED_BUDGET_EXHAUSTED" });
      continue;
    }
    const adapter = resolveActiveEtfAdapter(item.name, item.provider);
    if (!adapter) {
      activeEtfGapWithEvidence.push({ ...item, category: "SYSTEM", verifyNote: "NO_ADAPTER_RESOLVED" });
      continue;
    }
    const checkedAt = new Date().toISOString();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const snap = await adapter.fetchSnapshot(item.code, undefined, controller.signal).finally(() => clearTimeout(timer));
      const officialLatestDate = snap.dataDate;
      const stillOld = !!officialLatestDate && (!item.lastDataDate || officialLatestDate <= item.lastDataDate);
      if (stillOld) {
        activeEtfGapWithEvidence.push({ ...item, category: "EXTERNAL_DELAY", checkedAt, officialLatestDate });
      } else {
        // 官網其實有更新的資料，我方排程沒抓到——這是我方系統問題，不是外部延遲。
        activeEtfGapWithEvidence.push({ ...item, category: "SYSTEM", checkedAt, officialLatestDate, verifyNote: "OFFICIAL_SITE_HAS_NEWER_DATA_NOT_YET_INGESTED" });
      }
    } catch (e) {
      activeEtfGapWithEvidence.push({ ...item, category: "SYSTEM", checkedAt, verifyNote: `VERIFY_FAILED: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

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
  // published spot series. Uses FRED's public, keyless CSV endpoint (fredgraph.csv) instead of the
  // api_key-gated JSON endpoint -- 2026-10-21（使用者核准）: FRED_API_KEY is not set in Vercel
  // production (confirmed via `vercel env ls production`), and this endpoint needs no key at all,
  // so the cross-check no longer depends on that env var being configured anywhere.
  const fredRoots: Array<{ label: FredCommoditySample["label"]; rootId: string; ourSymbol: string; fredSeriesId: string }> = [
    { label: "WTI_CRUDE", rootId: "ceebeb1f-3616-4d38-ab85-a7de76455d9a", ourSymbol: "CL=F", fredSeriesId: "DCOILWTICO" },
    { label: "NATURAL_GAS", rootId: "8c9966ab-8e29-43bc-a4ff-e908fef9b2c2", ourSymbol: "NG=F", fredSeriesId: "DHHNGSP" },
  ];
  const fredSamples: FredCommoditySample[] = await Promise.all(
    fredRoots.map(async (r): Promise<FredCommoditySample> => {
      const ourRow = (await prisma.$queryRawUnsafe<Array<{ observed_date: string; close: string }>>(
        `SELECT observed_date::text, close::text FROM futures_root_market_observations WHERE root_id = $1::uuid ORDER BY observed_date DESC LIMIT 1`,
        r.rootId,
      ))[0];
      const base = { label: r.label, ourSymbol: r.ourSymbol, fredSeriesId: r.fredSeriesId, ourDate: ourRow?.observed_date ?? null, ourClose: ourRow ? Number(ourRow.close) : null };
      // 抓取失敗時同一次執行內重試，最多 3 次、間隔遞增（1s/2s/4s），降低外部來源偶發性逾時/限流
      // 被誤判成「資料異常」的機率；3 次都失敗才真的記為 fetchFailed。
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const url = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv");
          url.searchParams.set("id", r.fredSeriesId);
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new Error(`FRED_HTTP_${res.status}`);
          const csv = await res.text();
          const lines = csv.trim().split("\n").slice(1); // drop header row ("DATE,<series_id>")
          let obs: { date: string; value: string } | null = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            const [date, value] = lines[i].split(",");
            if (date && value && value !== ".") {
              obs = { date, value };
              break;
            }
          }
          const value = obs ? Number(obs.value) : null;
          if (value === null || Number.isNaN(value)) throw new Error("FRED_NO_VALUE");
          return { ...base, fredDate: obs!.date, fredValue: value, fetchFailed: false };
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
    // 每檔都已經用上面的即時查證分好 SYSTEM / EXTERNAL_DELAY，這裡依分類拆成最多兩筆，而不是
    // 整批套同一個分類——有證據（checkedAt/officialLatestDate）支持才會出現在 EXTERNAL_DELAY 那筆。
    ...(activeEtfGapWithEvidence.some((e) => e.category === SYSTEM_CATEGORY)
      ? [{ type: "ACTIVE_ETF_OFFICIAL_HOLDINGS_GAP", category: SYSTEM_CATEGORY, items: activeEtfGapWithEvidence.filter((e) => e.category === SYSTEM_CATEGORY) }]
      : []),
    ...(activeEtfGapWithEvidence.some((e) => e.category === "EXTERNAL_DELAY")
      ? [{ type: "ACTIVE_ETF_OFFICIAL_HOLDINGS_GAP", category: "EXTERNAL_DELAY" as const, items: activeEtfGapWithEvidence.filter((e) => e.category === "EXTERNAL_DELAY") }]
      : []),
    ...(localScheduleReporting.anomaly ? [{ type: "LOCAL_SCHEDULE_NOT_REPORTED", category: SYSTEM_CATEGORY, missing: localScheduleReporting.missing }] : []),
    ...(yahooTwCheck.anomaly ? [{ type: "YAHOO_TW_RETURN_MISMATCH", category: SYSTEM_CATEGORY, mismatches: yahooTwCheck.mismatches }] : []),
    ...(fredCommodityCheck.anomaly ? [{ type: "FRED_COMMODITY_MISMATCH", category: SYSTEM_CATEGORY, mismatches: fredCommodityCheck.mismatches }] : []),
    // core_universe_fund 的缺口現在有即時證據分類（見上面 coreUniverseFundGapWithEvidence），不
    // 再用這裡的籠統 COVERAGE 寫法；其他覆蓋率檢查（包含 core_universe_etf，還沒做證據查證）
    // 維持原本行為。
    ...coverage.filter((c) => c.anomaly && c.label !== "core_universe_fund" && c.label !== "core_universe_etf").map((c) => ({ type: "COVERAGE", category: SYSTEM_CATEGORY, label: c.label, reason: c.anomalyReason })),
    ...(coreUniverseFundGapWithEvidence.some((e) => e.category === SYSTEM_CATEGORY)
      ? [{ type: "COVERAGE", category: SYSTEM_CATEGORY, label: "core_universe_fund", reason: coreUniverseFundCoverage.anomalyReason, items: coreUniverseFundGapWithEvidence.filter((e) => e.category === SYSTEM_CATEGORY) }]
      : []),
    ...(coreUniverseFundGapWithEvidence.some((e) => e.category === "EXTERNAL_DELAY")
      ? [{ type: "COVERAGE", category: "EXTERNAL_DELAY" as const, label: "core_universe_fund", reason: coreUniverseFundCoverage.anomalyReason, items: coreUniverseFundGapWithEvidence.filter((e) => e.category === "EXTERNAL_DELAY") }]
      : []),
    ...(coreUniverseEtfGapWithEvidence.some((e) => e.category === SYSTEM_CATEGORY)
      ? [{ type: "COVERAGE", category: SYSTEM_CATEGORY, label: "core_universe_etf", reason: coreUniverseEtfCoverage.anomalyReason, items: coreUniverseEtfGapWithEvidence.filter((e) => e.category === SYSTEM_CATEGORY) }]
      : []),
    ...(coreUniverseEtfGapWithEvidence.some((e) => e.category === "EXTERNAL_DELAY")
      ? [{ type: "COVERAGE", category: "EXTERNAL_DELAY" as const, label: "core_universe_etf", reason: coreUniverseEtfCoverage.anomalyReason, items: coreUniverseEtfGapWithEvidence.filter((e) => e.category === "EXTERNAL_DELAY") }]
      : []),
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
    status, attempted: RUN_LOG_PIPELINES.length + 5 + coverage.length, completed: RUN_LOG_PIPELINES.length + 5 + coverage.length - anomalies.length,
    inserted: 0, updated: 0, failed: anomalies.length, retryableFailures: 0, checkpointAfter: null,
    details: {
      date: today, pipeline_health: pipelineHealth, stock_freshness: stockFreshness, domestic_fund_freshness: domesticFundFreshness,
      etf_data_source_gap: etfDataSourceGap, yahoo_tw_return_check: yahooTwCheck, fred_commodity_check: fredCommodityCheck, coverage,
      active_etf_official_holdings: activeEtfOfficialHoldings, active_etf_official_holdings_evidence: activeEtfGapWithEvidence, local_schedule_reporting: localScheduleReporting,
      core_universe_fund_gap_evidence: coreUniverseFundGapWithEvidence,
      core_universe_fund_never_reported_count: coreUniverseFundNeverReported.length,
      core_universe_fund_never_reported_sample: coreUniverseFundNeverReported.slice(0, 20),
      core_universe_etf_gap_evidence: coreUniverseEtfGapWithEvidence,
      moneydj_parse_failures: moneydjParseFailures,
      anomaly_count: anomalies.length, system_anomaly_count: systemAnomalyCount, external_delay_anomaly_count: externalDelayAnomalyCount,
      anomalies, notify_result: notifyResult,
    },
  });

  return Response.json({ ok: true, job: JOB, runId, status, anomalyCount: anomalies.length, systemAnomalyCount, externalDelayAnomalyCount, anomalies, etfDataSourceGap, activeEtfOfficialHoldings: activeEtfGapWithEvidence, yahooTwCheck, fredCommodityCheck, coverage, notifyResult });
}
