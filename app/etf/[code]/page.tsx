import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { isPublicReadyAsset } from "@/lib/data-platform/web/publicReadiness";
import { UniversalAssetDetail, type DetailData, type HistoryPoint, type Metric } from "@/components/asset/UniversalAssetDetail";
import { HoldingsTablePanel, ConcentrationPanel, HoldingsDiffPanel, type HoldingsTableApiResponse, type ConcentrationApiResponse, type HoldingsDiffApiResponse } from "@/components/holdings/HoldingsAnalysisPanels";
import { computeConcentration } from "@/lib/holdings/concentration";
import { getEtfHoldingsTableAsOf, getEtfHoldingsDiffLatestVsPrevious } from "@/lib/holdings/holdingsQueries";

// Read-only, additive to the existing detail data fetch above — a failure here must never affect
// whether the page itself renders (see the separate try/catch from the main `data` fetch).
async function loadEtfHoldingsPanels(etfId: string): Promise<{ table: HoldingsTableApiResponse; concentration: ConcentrationApiResponse; diff: HoldingsDiffApiResponse } | null> {
  try {
    const [table, diff] = await Promise.all([
      getEtfHoldingsTableAsOf(prisma, etfId),
      getEtfHoldingsDiffLatestVsPrevious(prisma, etfId),
    ]);
    if (!table.rows.length) return null; // no holdings snapshot yet — skip the section entirely
    const concentration = computeConcentration(table.rows);
    return {
      table: {
        ok: true, productType: "ETF", productId: table.productId, asOfDate: table.asOfDate, source: table.source,
        coverageDepth: table.coverage.coverage_depth, isFullHoldings: table.coverage.is_full_holdings,
        holdingCount: table.coverage.holding_count, incompleteDataWarning: !table.coverage.is_full_holdings,
        rows: table.rows.map((r) => ({ key: r.key, name: r.name, ticker: r.ticker, weightPct: r.weightPct, sector: r.sector ?? null, country: r.country ?? null })),
      },
      concentration: {
        ok: true, productType: "ETF", productId: table.productId, asOfDate: table.asOfDate,
        coverageDepth: table.coverage.coverage_depth, isFullHoldings: table.coverage.is_full_holdings,
        basisNote: table.coverage.is_full_holdings ? "基於完整持股計算" : "依目前可取得持股計算（非完整持股，實際集中度可能不同）",
        top10Pct: concentration.top10Pct, top20Pct: concentration.top20Pct, largestHolding: concentration.largestHolding,
        sectorConcentration: concentration.sectorConcentration, countryConcentration: concentration.countryConcentration,
      },
      diff: {
        ok: true, productType: "ETF", productId: diff.productId, hasEnoughHistory: diff.hasEnoughHistory,
        previousDate: diff.previousDate, latestDate: diff.latestDate,
        added: diff.entries.filter((e) => e.change === "ADDED"),
        increased: diff.entries.filter((e) => e.change === "INCREASED"),
        decreased: diff.entries.filter((e) => e.change === "DECREASED"),
        removed: diff.entries.filter((e) => e.change === "REMOVED"),
      },
    };
  } catch {
    return null;
  }
}

const fmt = (value: unknown, suffix = "") => value == null ? "—" : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 })}${suffix}`;
const dateText = (value: Date | null | undefined) => value ? value.toISOString().slice(0, 10) : undefined;
const metric = (label: string, value: unknown, suffix = ""): Metric => ({ label, value: fmt(value, suffix) });

export default async function EtfDetailPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!await isPublicReadyAsset("ETF", decodeURIComponent(code))) notFound();
  let data: DetailData | null = null;
  let etfId: string | null = null;
  try {
    const etf = await prisma.etf.findUnique({ where: { code: decodeURIComponent(code) }, include: { history: { where: { price: { not: null } }, orderBy: { date: "desc" }, take: 5000 } } });
    if (etf) {
      etfId = etf.id;
      const latestRow = etf.history[0];
      const previousRow = etf.history[1];
      const allHistory: HistoryPoint[] = etf.history.toReversed().map((row) => ({ date: row.date.toISOString().slice(0, 10), value: Number(row.price) })).filter((row) => Number.isFinite(row.value));
      const latest = latestRow?.price != null ? Number(latestRow.price) : (etf.latestPrice == null ? null : Number(etf.latestPrice));
      const previous = previousRow?.price != null ? Number(previousRow.price) : undefined;
      const change = latest != null && Number.isFinite(latest) && previous != null ? latest - previous : null;
      const sameDateNav = latestRow?.nav ?? null;
      const sameDatePremium = latestRow?.price != null && sameDateNav != null ? ((Number(latestRow.price) / Number(sameDateNav)) - 1) * 100 : null;
      // "相關資產" must reflect a single canonical snapshot (the latest as_of_date), never a
      // rank-only ordering across every historical snapshot — that previously produced repeated
      // rank-1 rows (e.g. multiple 台積電 entries) from different ingestion dates.
      const latestHoldingAgg = await prisma.holding.aggregate({ where: { etfId: etf.id, assetType: "ETF" }, _max: { asOfDate: true } });
      const holdingsAsOfDate = latestHoldingAgg._max.asOfDate;
      const holdingsAtLatestDate = holdingsAsOfDate
        ? await prisma.holding.findMany({ where: { etfId: etf.id, assetType: "ETF", asOfDate: holdingsAsOfDate }, orderBy: { rank: "asc" } })
        : [];
      const seenHoldingKeys = new Set<string>();
      const dedupedHoldings: typeof holdingsAtLatestDate = [];
      for (const holding of holdingsAtLatestDate) {
        const key = holding.securityId ?? holding.holdingCode ?? holding.holdingName;
        if (seenHoldingKeys.has(key)) continue;
        seenHoldingKeys.add(key);
        dedupedHoldings.push(holding);
      }
      const holdingsCount = dedupedHoldings.length;
      const related = dedupedHoldings.slice(0, 10).map((holding) => ({ label: `${holding.rank}. ${holding.holdingName}${holding.holdingCode ? ` (${holding.holdingCode})` : ""}`, value: `${Number(holding.weight).toFixed(2)}%${holding.sector ? `・${holding.sector}` : ""}${holding.country ? `・${holding.country}` : ""}` }));
      data = { type: "ETF", code: etf.code, name: etf.name, officialName: etf.nameEn ?? undefined, exchange: etf.exchange ?? undefined, region: etf.region ?? undefined, currency: etf.currency, isin: etf.isin ?? undefined, summary: [metric("最新價格", latest), metric("NAV（同期）", sameDateNav), metric("Premium / Discount（同期）", sameDatePremium, "%"), { label: "漲跌 / 漲跌幅", value: change == null || !previous ? "—" : `${fmt(change)} / ${((change / previous) * 100).toFixed(2)}%` }], performance: [metric("1M", etf.return1m, "%"), metric("3M", etf.return3m, "%"), metric("6M", etf.return6m, "%"), metric("YTD", etf.returnYtd, "%"), metric("1Y", etf.return1y, "%"), metric("3Y", etf.return3y, "%"), metric("5Y", etf.return5y, "%")], risk: [metric("Volatility", etf.volatility1y, "%"), metric("Beta", etf.beta), metric("Max Drawdown", etf.maxDrawdown, "%"), metric("Sharpe", etf.sharpe1y)], keyData: [metric("NAV", etf.latestNav), metric("AUM", etf.aum), metric("Expense Ratio", etf.expenseRatio, "%"), metric("Dividend Yield", etf.dividendYield, "%"), { label: "Issuer", value: etf.provider }, { label: "Asset Class", value: etf.category ?? "—" }, { label: "Benchmark", value: etf.benchmark ?? "—" }, { label: "Holdings Count", value: holdingsCount ? String(holdingsCount) : "—" }, metric("Premium / Discount", sameDatePremium, "%")], relatedData: related, history: allHistory, priceDate: dateText(latestRow?.date ?? etf.priceUpdatedAt), source: etf.dataProvider ?? etf.provider, lastUpdated: dateText(etf.updatedAt), updatedAt: dateText(etf.priceUpdatedAt ?? etf.updatedAt), frequency: "依既有 ETF Canonical Data 更新" };
    }
  } catch { data = null; }
  if (!data) notFound();
  const panels = etfId ? await loadEtfHoldingsPanels(etfId) : null;
  return (
    <>
      <UniversalAssetDetail data={data} requestedCode={decodeURIComponent(code)} assetType="ETF"/>
      {panels && (
        <div className="mx-auto max-w-[1500px] px-6 pb-10 md:px-10">
          <HoldingsTablePanel data={panels.table} />
          <ConcentrationPanel data={panels.concentration} />
          <HoldingsDiffPanel data={panels.diff} />
        </div>
      )}
    </>
  );
}

