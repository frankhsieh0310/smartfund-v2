import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { isPublicReadyAsset } from "@/lib/data-platform/web/publicReadiness";
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
  if (!await isPublicReadyAsset("ETF", decodeURIComponent(code))) notFound();
  let data: DetailData | null = null;
  try {
    const etf = await prisma.etf.findUnique({ where: { code: decodeURIComponent(code) }, include: { history: { where: { price: { not: null } }, orderBy: { date: "desc" }, take: 5000 }, holdings: { orderBy: { rank: "asc" }, take: 10 }, _count: { select: { holdings: true } } } });
    if (etf) {
      const latestRow = etf.history[0];
      const previousRow = etf.history[1];
      const allHistory: HistoryPoint[] = etf.history.toReversed().map((row) => ({ date: row.date.toISOString().slice(0, 10), value: Number(row.price) })).filter((row) => Number.isFinite(row.value));
      const latest = latestRow?.price != null ? Number(latestRow.price) : (etf.latestPrice == null ? null : Number(etf.latestPrice));
      const previous = previousRow?.price != null ? Number(previousRow.price) : undefined;
      const change = latest != null && Number.isFinite(latest) && previous != null ? latest - previous : null;
      const sameDateNav = latestRow?.nav ?? null;
      const sameDatePremium = latestRow?.price != null && sameDateNav != null ? ((Number(latestRow.price) / Number(sameDateNav)) - 1) * 100 : null;
      const related = etf.holdings.map((holding) => ({ label: `${holding.rank}. ${holding.holdingName}${holding.holdingCode ? ` (${holding.holdingCode})` : ""}`, value: `${Number(holding.weight).toFixed(2)}%${holding.sector ? `・${holding.sector}` : ""}${holding.country ? `・${holding.country}` : ""}` }));
      data = { type: "ETF", code: etf.code, name: etf.name, officialName: etf.nameEn ?? undefined, exchange: etf.exchange ?? undefined, region: etf.region ?? undefined, currency: etf.currency, isin: etf.isin ?? undefined, summary: [metric("最新價格", latest), metric("NAV（同期）", sameDateNav), metric("Premium / Discount（同期）", sameDatePremium, "%"), { label: "漲跌 / 漲跌幅", value: change == null || !previous ? "—" : `${fmt(change)} / ${((change / previous) * 100).toFixed(2)}%` }], performance: [metric("1M", etf.return1m, "%"), metric("3M", etf.return3m, "%"), metric("6M", etf.return6m, "%"), metric("YTD", etf.returnYtd, "%"), metric("1Y", etf.return1y, "%"), metric("3Y", etf.return3y, "%"), metric("5Y", etf.return5y, "%")], risk: [metric("Volatility", etf.volatility1y, "%"), metric("Beta", etf.beta), metric("Max Drawdown", etf.maxDrawdown, "%"), metric("Sharpe", etf.sharpe1y)], keyData: [metric("NAV", etf.latestNav), metric("AUM", etf.aum), metric("Expense Ratio", pctFraction(etf.expenseRatio), "%"), metric("Dividend Yield", pctFraction(etf.dividendYield), "%"), { label: "Issuer", value: etf.provider }, { label: "Asset Class", value: etf.category ?? "—" }, { label: "Benchmark", value: etf.benchmark ?? "—" }, { label: "Holdings Count", value: etf._count.holdings ? String(etf._count.holdings) : "—" }, metric("Premium / Discount", sameDatePremium, "%")], relatedData: related, history: allHistory, priceDate: dateText(latestRow?.date ?? etf.priceUpdatedAt), source: etf.dataProvider ?? etf.provider, lastUpdated: dateText(etf.updatedAt), updatedAt: dateText(etf.priceUpdatedAt ?? etf.updatedAt), frequency: "依既有 ETF Canonical Data 更新" };
    }
  } catch { data = null; }
  if (!data) notFound();
  return <UniversalAssetDetail data={data} requestedCode={decodeURIComponent(code)} assetType="ETF"/>;
}

