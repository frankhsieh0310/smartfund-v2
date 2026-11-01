import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCoreUniverseEtfIds } from "@/lib/tw-purchasable/coreUniverseFilter";
import { freshnessStatus as computeFreshnessStatus } from "@/lib/data-platform/web/freshness";
import { computeTechnicalSeries, type PricePoint } from "@/lib/cron/stockTechnicalDaily";
import { TRACKED_YUANTA_FUND_IDS } from "@/lib/etf-holdings-engine/adapters/yuantaTrackingDifference";
import { calculateVolatilityAndSharpe, RISK_CALC_METHOD_LABEL, RISK_FREE_RATE_SOURCES, RISK_FREE_RATE_UNAVAILABLE_REASON } from "@/lib/data-platform/web/riskCalc";
import { UniversalAssetDetail, type DetailData, type HistoryPoint, type Metric } from "@/components/asset/UniversalAssetDetail";

const fmt = (value: unknown, suffix = "") => value == null ? "—" : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 })}${suffix}`;
const dateText = (value: Date | null | undefined) => value ? value.toISOString().slice(0, 10) : undefined;
const metric = (label: string, value: unknown, suffix = ""): Metric => ({ label, value: fmt(value, suffix) });
// expenseRatio/dividendYield are stored as fractions upstream (0.0032 = 0.32%) -- same convention
// documented in smartmatch-mobile's src/detail/service.ts (pct2()). Performance/risk fields
// (return1m/3m/..., volatility1y, maxDrawdown) are NOT fractions, already percentage points --
// do not apply this to those.
const pctFraction = (value: unknown) => value == null ? null : Number(value) * 100;

export default async function EtfDetailPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let data: DetailData | null = null;
  try {
    // 2026-10-29（VERIFIED，競品對照稽核發現的資料正確性bug）: holdings是「每個as_of_date一份
    // 完整持股快照」的表，之前這裡的include完全沒有依最新as_of_date過濾就orderBy rank take 10、
    // _count整張表——結果「Holdings Count」把全部歷史快照的列數加總顯示（0050 VERIFIED顯示
    // 2164，實際該檔只有50-102檔），「相關資產」也變成跨日期混抓rank最小的10列（0050 VERIFIED
    // 11個項目全部顯示"1. 台積電"，因為每個快照日的rank=1剛好都是台積電，排序時贏過其他快照日
    // 的rank=2,3...）。改成先查最新as_of_date，holdings跟count都鎖定那一天，跟lib/data-platform/
    // web/etfService.ts的getEtfDetail本來就用的作法一致（那支本來就是對的，只有這支page.tsx有
    // 這個bug）。
    const latestHoldingDate = await prisma.holding.findFirst({ where: { etf: { code: decodeURIComponent(code) } }, orderBy: { asOfDate: "desc" }, select: { asOfDate: true } });
    const etf = await prisma.etf.findUnique({
      where: { code: decodeURIComponent(code) },
      include: {
        history: { where: { price: { not: null } }, orderBy: { date: "desc" }, take: 5000 },
        // 不在這裡take:10 -- 同一天、同一檔持股常被兩條不同的擷取來源各寫一筆（VERIFIED 0050
        // 2026-10-27同時有 ETF_OFFICIAL_DAILY_SNAPSHOT 跟 官方網頁URL 兩種source，security_id
        // 相同、weight相同），先把當天全部抓出來，下面依security_id/holdingName去重後再取前10，
        // 不然原本的take:10會在去重前就被同一檔的重複列塞滿（VERIFIED「相關資產」曾經11項全部
        // 顯示"1. 台積電"）。
        holdings: latestHoldingDate ? { where: { asOfDate: latestHoldingDate.asOfDate }, orderBy: { rank: "asc" } } : { where: { id: "" } },
      },
    });
    // 2026-10-24（使用者規則）: 核心母體商品的詳情頁永遠不准 404。之前這裡用 isPublicReadyAsset
    // 擋掉任何「最新一筆 etf_history 不是當前交易日」的 ETF -- VERIFIED live 這個規則錯誤地把
    // 「今天不是交易日/資料還沒輪到更新」當成「這檔 ETF 不給看」，連 0050 這種龍頭 ETF 都擋掉。
    // 只保留「是不是核心母體」這一道門（維持跟清單/搜尋頁一致的範圍），資料新不新只拿來決定畫面
    // 上的「資料狀態」標籤（下面 freshnessStatus），不再拿來擋頁面本身。isPublicReadyAsset 本身
    // 沒有被動到，watchlists/portfolios 加項目那邊的驗證規則維持原樣。
    const coreIds = etf ? await getCoreUniverseEtfIds() : null;
    if (etf && coreIds && !coreIds.has(etf.id)) data = null;
    else if (etf) {
      const latestRow = etf.history[0];
      const previousRow = etf.history[1];
      const ascHistory = etf.history.toReversed();
      // 技術分析（2026-10-24 修正）: etfs 沒有 StockTechnical 那種每日預先算好的指標表，之前這裡
      // 只傳 {date,value} 給圖表元件，SMA/EMA/RSI/MACD/布林通道/KD/ATR 全部沒東西可畫（獨立驗收
      // 代理發現：按鈕能選取但完全沒畫出任何線）。etf_history 本來就有真實 open/high/low/close/
      // volume（VERIFIED SVIX 近三日資料），所以用既有的 computeTechnicalSeries()（跟
      // stock_technical 排程算法完全相同的公式，lib/cron/stockTechnicalDaily.ts）就地計算，不需要
      // 新建資料表或排程——CLAUDE.md 明確允許「技術指標本身的計算公式」這個例外。
      const pricePoints: PricePoint[] = ascHistory.map((row) => ({ date: row.date, high: row.high != null ? Number(row.high) : null, low: row.low != null ? Number(row.low) : null, close: row.close != null ? Number(row.close) : Number(row.price) })).filter((p) => Number.isFinite(p.close));
      const technicalByDate = new Map(computeTechnicalSeries(pricePoints).map((row) => [row.date, row]));
      const allHistory: HistoryPoint[] = ascHistory.map((row) => {
        const dateKey = row.date.toISOString().slice(0, 10);
        const t = technicalByDate.get(dateKey);
        return {
          date: dateKey, value: Number(row.price),
          open: row.open != null ? Number(row.open) : null, high: row.high != null ? Number(row.high) : null, low: row.low != null ? Number(row.low) : null, close: row.close != null ? Number(row.close) : null, volume: row.volume != null ? Number(row.volume) : null,
          ma20: t?.ma20 ?? null, ema12: t?.ema12 ?? null, macd: t?.macd ?? null, macdSignal: t?.macdSignal ?? null, rsi14: t?.rsi14 ?? null, kdK: t?.kdK ?? null, kdD: t?.kdD ?? null, atr14: t?.atr14 ?? null, bollingerUpper: t?.bollingerUpper ?? null, bollingerMiddle: t?.bollingerMiddle ?? null, bollingerLower: t?.bollingerLower ?? null,
        };
      }).filter((row) => Number.isFinite(row.value));
      const latest = latestRow?.price != null ? Number(latestRow.price) : (etf.latestPrice == null ? null : Number(etf.latestPrice));
      const previous = previousRow?.price != null ? Number(previousRow.price) : undefined;
      const change = latest != null && Number.isFinite(latest) && previous != null ? latest - previous : null;
      // 2026-10-30（使用者核准，ETF折溢價接官方資料，取代2026-10-29/上午那兩版自算邏輯）:
      // 上一版VERIFIED etfs.latest_nav是死資料（沒有任何排程更新），自算折溢價會把死NAV配上
      // 新價格，算出不合理數字。現在改成直接讀證交所MIS官方發布的折溢價（app/api/cron/
      // cloud-etf-price/route.ts的ETF_PREMIUM_DISCOUNT_SYNC步驟寫進etf_history.premium），
      // 這個值跟它自己的date一起查、只信同一筆記錄，不跟latestRow的price交叉配對，3天內的才顯示，
      // 避免排程中斷時顯示過期數字。
      const premiumRow = await prisma.etfHistory.findFirst({ where: { etfId: etf.id, premium: { not: null } }, orderBy: { date: "desc" }, select: { premium: true, nav: true, date: true } });
      const premiumAgeDays = premiumRow ? (Date.now() - premiumRow.date.getTime()) / 86_400_000 : null;
      const premiumFresh = premiumAgeDays != null && premiumAgeDays <= 3;
      const sameDatePremium = premiumFresh ? Number(premiumRow!.premium) : null;
      const sameDateNav = premiumFresh && premiumRow!.nav != null ? Number(premiumRow!.nav) : null;
      // 2026-10-30（使用者核准）: 證交所MIS這份資料本質是盤中預估值（投信/總代理人自己算的
      // 「預估淨值」，不是收盤後結算的正式淨值），標籤要清楚標示「預估」，不能讓人誤以為是
      // 官方結算後的折溢價；附上資料日期，跟上面trackingMetrics同一套「標示來源跟日期」慣例。
      const premiumLabel = "預估折溢價（證交所MIS）";
      const premiumDisplay = sameDatePremium != null && premiumRow
        ? `${fmt(sameDatePremium, "%")}（${dateText(premiumRow.date)}盤中預估，來源：證交所MIS）`
        : "—";
      // 同一檔持股被不同來源各寫一筆時，優先留 ETF_OFFICIAL_DAILY_SNAPSHOT 那一筆（官方每日快照
      // 流程，比舊版URL字串來源的欄位更完整）；兩者都沒有就留先出現的那筆，不是用猜的，只是避免
      // 同一檔重複顯示兩次。
      const dedupedHoldings = [...new Map(
        etf.holdings
          .slice()
          .sort((a, b) => (a.source === "ETF_OFFICIAL_DAILY_SNAPSHOT" ? -1 : b.source === "ETF_OFFICIAL_DAILY_SNAPSHOT" ? 1 : 0))
          .map((holding) => [holding.securityId ?? holding.holdingName, holding] as const),
      ).values()].sort((a, b) => a.rank - b.rank);
      const related = dedupedHoldings.slice(0, 10).map((holding) => ({ label: `${holding.rank}. ${holding.holdingName}${holding.holdingCode ? ` (${holding.holdingCode})` : ""}`, value: `${Number(holding.weight).toFixed(2)}%${holding.sector ? `・${holding.sector}` : ""}${holding.country ? `・${holding.country}` : ""}` }));
      // 純顯示用：資料夠不夠新只決定畫面上的「資料狀態」標籤文字，不再決定頁面能不能打開。
      const displayFreshness: DetailData["freshnessStatus"] = computeFreshnessStatus(latestRow?.date ?? etf.priceUpdatedAt ?? null, "MARKET_DAY") === "CURRENT" ? "LATEST" : "STALE";
      // 2026-10-29（使用者核准，免費功能缺口——風險指標）: VERIFIED etfs.volatility_1y/sharpe_1y
      // 這兩欄幾乎整表是空的（6201檔只有4筆volatility、0筆sharpe），只有beta有93%覆蓋率。
      // 兩欄位沒有官方/Yahoo數字可抄，照CLAUDE.md「技術與風險指標可依真實價格計算」的例外，用
      // etf_history真實收盤價自行計算年化標準差跟夏普值（lib/data-platform/web/riskCalc.ts），
      // 一律標示「本App計算」，官方欄位本身有值時優先用官方的，沒有才用自算的頂上。
      const oneYearAgo = new Date(Date.UTC(new Date().getUTCFullYear() - 1, new Date().getUTCMonth(), new Date().getUTCDate()));
      // 無風險利率只有USD有官方自動化來源（美國財政部3個月期公債殖利率）；其他幣別（包含TWD）
      // 查過的來源都還不能自動擷取（見riskCalc.ts的說明），照使用者指示不計算夏普值、標示原因，
      // 不拿別的幣別利率頂替。
      const riskFreeSource = RISK_FREE_RATE_SOURCES[etf.currency ?? ""];
      let riskFreeRatePct: number | null = null;
      let riskFreeRateAsOf: string | null = null;
      if (riskFreeSource) {
        const riskFreeRateRow = await prisma.$queryRawUnsafe<{ value: unknown; observation_date: Date }[]>(
          `SELECT value, observation_date FROM treasury_fiscal_observations WHERE metric_code = $1 ORDER BY observation_date DESC LIMIT 1`,
          riskFreeSource.metricCode,
        );
        riskFreeRatePct = riskFreeRateRow[0]?.value != null ? Number(riskFreeRateRow[0].value) : null;
        riskFreeRateAsOf = riskFreeRateRow[0]?.observation_date ? dateText(riskFreeRateRow[0].observation_date) ?? null : null;
      }
      const sharpeUnavailableReason = !riskFreeSource ? (RISK_FREE_RATE_UNAVAILABLE_REASON[etf.currency ?? ""] ?? `尚無${etf.currency ?? "此幣別"}的官方無風險利率自動化來源，暫不計算夏普值`) : null;
      const calculatedRisk = calculateVolatilityAndSharpe(
        ascHistory.filter((row) => row.date >= oneYearAgo && row.price != null).map((row) => ({ date: row.date, close: Number(row.price) })),
        riskFreeRatePct,
      );
      const volatilityMetric: Metric = etf.volatility1y != null
        ? metric("Volatility", etf.volatility1y, "%")
        : { label: "Volatility", value: calculatedRisk.volatility1yPct != null ? `${fmt(calculatedRisk.volatility1yPct, "%")}（本App計算）` : "—" };
      const sharpeMetric: Metric = etf.sharpe1y != null
        ? metric("Sharpe", etf.sharpe1y)
        : sharpeUnavailableReason
          ? { label: "Sharpe", value: `—（${sharpeUnavailableReason}）` }
          : { label: "Sharpe", value: calculatedRisk.sharpe1y != null ? `${calculatedRisk.sharpe1y.toFixed(2)}（本App計算）` : "—" };
      const riskMethodNote = etf.volatility1y == null || etf.sharpe1y == null
        ? `${RISK_CALC_METHOD_LABEL}${riskFreeSource ? `無風險利率來源：${riskFreeSource.label}${riskFreeRateAsOf ? `（資料日期：${riskFreeRateAsOf}）` : ""}。` : ""}`
        : null;
      // 2026-10-29（使用者核准）: 追蹤差距只對元大發行、且在TRACKED_YUANTA_FUND_IDS名單裡的ETF
      // 有意義（照抄元大官網自己公布的數字，不是自算）——不在名單裡的ETF，這組欄位永遠不適用，
      // 維持完全不顯示，不是「無資料」。
      // 2026-10-30（使用者核准，淨值欄顯示異常修正）: 改讀專屬的 etf_tracking_difference 表，
      // 不再跟 etf_asset_metrics.nav 共用欄位（那是造成列表頁淨值顯示-1.47的根因）。
      // 2026-10-31（使用者核准，更正）: 名單內的ETF如果這次沒有資料（例如元大官網這批還沒更新
      // 或剛被還原漏掉），改成明確顯示「無資料」，不要整段消失——避免使用者看不出「這檔本來就
      // 有追蹤差距，只是這次沒資料」跟「這檔本來就不追蹤差距」的差別。
      const isYuantaTracked = Object.values(TRACKED_YUANTA_FUND_IDS).includes(etf.code);
      const trackingRows = await prisma.$queryRawUnsafe<{ daily_pct: unknown; cumulative_pct: unknown; observation_date: Date }[]>(
        `SELECT daily_pct, cumulative_pct, observation_date FROM etf_tracking_difference WHERE etf_id = $1 AND source = 'YUANTA_OFFICIAL' ORDER BY observation_date DESC LIMIT 1`,
        etf.id,
      ).catch(() => []);
      const trackingRow = trackingRows[0];
      // 2026-11-01（使用者核准）：expense_ratio_tier_text 刻意不進schema.prisma（理由見
      // etfService.ts getEtfDetail 同一欄位旁的註解），這裡跟trackingRows同樣用raw SQL單獨查，
      // 欄位還沒ALTER TABLE套用前查詢失敗就catch成null，不影響頁面其他部分。
      const tierTextRows = await prisma.$queryRawUnsafe<{ expense_ratio_tier_text: string | null }[]>(
        `SELECT expense_ratio_tier_text FROM etfs WHERE id = $1`, etf.id,
      ).catch(() => []);
      const expenseRatioTierText = tierTextRows[0]?.expense_ratio_tier_text ?? null;
      const trackingMetrics: Metric[] = isYuantaTracked ? [
        { label: "追蹤差距（日）", value: trackingRow?.daily_pct != null ? `${fmt(trackingRow.daily_pct, "%")}（${dateText(trackingRow.observation_date)}，來源：元大投信官網）` : "無資料" },
        { label: "追蹤差距（累計）", value: trackingRow?.cumulative_pct != null ? `${fmt(trackingRow.cumulative_pct, "%")}（${dateText(trackingRow.observation_date)}，來源：元大投信官網）` : "無資料" },
      ] : [];
      data = { type: "ETF", code: etf.code, name: etf.name, officialName: etf.nameEn ?? undefined, exchange: etf.exchange ?? undefined, region: etf.region ?? undefined, currency: etf.currency, isin: etf.isin ?? undefined, summary: [metric("最新價格", latest), metric("NAV（同期，證交所MIS盤中預估）", sameDateNav), { label: premiumLabel, value: premiumDisplay }, { label: "漲跌 / 漲跌幅", value: change == null || !previous ? "—" : `${fmt(change)} / ${((change / previous) * 100).toFixed(2)}%` }], performance: [metric("1M", etf.return1m, "%"), metric("3M", etf.return3m, "%"), metric("6M", etf.return6m, "%"), metric("YTD", etf.returnYtd, "%"), metric("1Y", etf.return1y, "%"), metric("3Y", etf.return3y, "%"), metric("5Y", etf.return5y, "%")], risk: [volatilityMetric, metric("Beta", etf.beta), metric("Max Drawdown", etf.maxDrawdown, "%"), sharpeMetric, ...(riskMethodNote ? [{ label: "計算方法", value: riskMethodNote }] : [])], keyData: [metric("NAV", etf.latestNav), metric("AUM", etf.aum), (etf.expenseRatio == null && expenseRatioTierText) ? { label: "Expense Ratio", value: `${expenseRatioTierText}（原文為官網費率級距/區間，本App未自行加權換算）` } : metric("Expense Ratio", pctFraction(etf.expenseRatio), "%"), etf.distributionFreq === "NONE" ? { label: "Dividend Yield", value: "本基金不配息（來源：發行商官網「收益分配」欄位）" }
        : etf.distributionFreq === "NO_DIST_12M_YAHOO" ? { label: "Dividend Yield", value: "近12個月未配息（來源：Yahoo）" }
        : (etf.distributionFreq === "UNSPECIFIED" && etf.dividendYield == null) ? { label: "Dividend Yield", value: "可配息，至今未曾配息（資料來源：發行商官網、Yahoo）" }
        : metric("Dividend Yield", pctFraction(etf.dividendYield), "%"), { label: "Issuer", value: etf.provider }, { label: "Asset Class", value: etf.category ?? "—" }, { label: "Benchmark", value: etf.benchmark ?? "—" }, { label: "Holdings Count", value: dedupedHoldings.length ? String(dedupedHoldings.length) : "—" }, { label: premiumLabel, value: premiumDisplay }, ...trackingMetrics], relatedData: related, history: allHistory, priceDate: dateText(latestRow?.date ?? etf.priceUpdatedAt), source: etf.dataProvider ?? etf.provider, lastUpdated: dateText(etf.updatedAt), updatedAt: dateText(etf.priceUpdatedAt ?? etf.updatedAt), frequency: "依既有 ETF Canonical Data 更新", freshnessStatus: displayFreshness };
    }
  } catch { data = null; }
  if (!data) notFound();
  return <UniversalAssetDetail data={data} requestedCode={decodeURIComponent(code)} assetType="ETF"/>;
}

