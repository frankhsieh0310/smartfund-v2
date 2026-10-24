import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCoreUniverseEtfIds } from "@/lib/tw-purchasable/coreUniverseFilter";
import { freshnessStatus as computeFreshnessStatus } from "@/lib/data-platform/web/freshness";
import { computeTechnicalSeries, type PricePoint } from "@/lib/cron/stockTechnicalDaily";
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
    const etf = await prisma.etf.findUnique({ where: { code: decodeURIComponent(code) }, include: { history: { where: { price: { not: null } }, orderBy: { date: "desc" }, take: 5000 }, holdings: { orderBy: { rank: "asc" }, take: 10 }, _count: { select: { holdings: true } } } });
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
      const sameDateNav = latestRow?.nav ?? null;
      const sameDatePremium = latestRow?.price != null && sameDateNav != null ? ((Number(latestRow.price) / Number(sameDateNav)) - 1) * 100 : null;
      const related = etf.holdings.map((holding) => ({ label: `${holding.rank}. ${holding.holdingName}${holding.holdingCode ? ` (${holding.holdingCode})` : ""}`, value: `${Number(holding.weight).toFixed(2)}%${holding.sector ? `・${holding.sector}` : ""}${holding.country ? `・${holding.country}` : ""}` }));
      // 純顯示用：資料夠不夠新只決定畫面上的「資料狀態」標籤文字，不再決定頁面能不能打開。
      const displayFreshness: DetailData["freshnessStatus"] = computeFreshnessStatus(latestRow?.date ?? etf.priceUpdatedAt ?? null, "MARKET_DAY") === "CURRENT" ? "LATEST" : "STALE";
      data = { type: "ETF", code: etf.code, name: etf.name, officialName: etf.nameEn ?? undefined, exchange: etf.exchange ?? undefined, region: etf.region ?? undefined, currency: etf.currency, isin: etf.isin ?? undefined, summary: [metric("最新價格", latest), metric("NAV（同期）", sameDateNav), metric("Premium / Discount（同期）", sameDatePremium, "%"), { label: "漲跌 / 漲跌幅", value: change == null || !previous ? "—" : `${fmt(change)} / ${((change / previous) * 100).toFixed(2)}%` }], performance: [metric("1M", etf.return1m, "%"), metric("3M", etf.return3m, "%"), metric("6M", etf.return6m, "%"), metric("YTD", etf.returnYtd, "%"), metric("1Y", etf.return1y, "%"), metric("3Y", etf.return3y, "%"), metric("5Y", etf.return5y, "%")], risk: [metric("Volatility", etf.volatility1y, "%"), metric("Beta", etf.beta), metric("Max Drawdown", etf.maxDrawdown, "%"), metric("Sharpe", etf.sharpe1y)], keyData: [metric("NAV", etf.latestNav), metric("AUM", etf.aum), metric("Expense Ratio", pctFraction(etf.expenseRatio), "%"), metric("Dividend Yield", pctFraction(etf.dividendYield), "%"), { label: "Issuer", value: etf.provider }, { label: "Asset Class", value: etf.category ?? "—" }, { label: "Benchmark", value: etf.benchmark ?? "—" }, { label: "Holdings Count", value: etf._count.holdings ? String(etf._count.holdings) : "—" }, metric("Premium / Discount", sameDatePremium, "%")], relatedData: related, history: allHistory, priceDate: dateText(latestRow?.date ?? etf.priceUpdatedAt), source: etf.dataProvider ?? etf.provider, lastUpdated: dateText(etf.updatedAt), updatedAt: dateText(etf.priceUpdatedAt ?? etf.updatedAt), frequency: "依既有 ETF Canonical Data 更新", freshnessStatus: displayFreshness };
    }
  } catch { data = null; }
  if (!data) notFound();
  return <UniversalAssetDetail data={data} requestedCode={decodeURIComponent(code)} assetType="ETF"/>;
}

