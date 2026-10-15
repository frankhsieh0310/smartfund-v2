// Task X12 (round-6 instruction 四-8): backend for the App's "開始穿透分析" button
// (app/results.tsx -> src/portfolio/lookThrough.ts), which has existed since before this QA
// engagement calling /api/holdings/portfolio-analysis -- a route that was never built, so the button
// was hidden. Reuses getLatestSnapshot (the same function the already-live
// /api/holdings/[type]/[id]/table route uses) per product, weights each holding by the product's own
// portfolio weight, and aggregates -- no new pipeline, no new table.
import { prisma } from "@/lib/prisma";
import { getLatestSnapshot, coverageDepthOf, type ProductType, type CoverageDepth } from "./holdingsHistory";

export type AllocationMode = "AMOUNT" | "WEIGHT";
export type SelectedProductInput = { assetType: "ETF" | "FUND"; id: string; value: number };

type ProductResult = {
  ref: string; assetType: "ETF" | "FUND"; id: string; code: string | null; name: string | null; weightPct: number; included: boolean;
  coverageDepth: CoverageDepth | null; presentRowCount: number; declaredCount: number | null; asOfDate: string | null; holdingsCoveredPct: number | null;
};

async function fetchName(assetType: "ETF" | "FUND", id: string): Promise<{ code: string | null; name: string | null } | null> {
  const table = assetType === "ETF" ? "etfs" : "funds";
  const rows = await prisma.$queryRawUnsafe<Array<{ code: string | null; name: string | null }>>(`SELECT code, name FROM ${table} WHERE id = $1`, id);
  return rows[0] ?? null;
}

export async function computePortfolioLookThrough(items: SelectedProductInput[], mode: AllocationMode) {
  const totalRaw = items.reduce((acc, i) => acc + (Number.isFinite(i.value) ? i.value : 0), 0);
  const weightSumOk = totalRaw > 0;

  const excludedProducts: Array<{ ref: string; label: string; name: string | null; reason: "NO_HOLDINGS" | "NOT_FOUND" }> = [];
  const incompleteProducts: Array<{ ref: string; label: string; coverageDepth: CoverageDepth; presentRowCount: number; declaredCount: number | null }> = [];
  const products: ProductResult[] = [];

  // stockKey -> { name, ticker, exposurePct, holders: Set<ref>, contributions }
  type Agg = { name: string; ticker: string | null; sector: string | null; country: string | null; exposurePct: number; holders: Map<string, number> };
  const stocks = new Map<string, Agg>();
  let lookedThroughPct = 0;

  for (const item of items) {
    const ref = `${item.assetType}:${item.id}`;
    const weightPct = weightSumOk ? (item.value / totalRaw) * 100 : 0;
    const basics = await fetchName(item.assetType, item.id);
    if (!basics) {
      excludedProducts.push({ ref, label: ref, name: null, reason: "NOT_FOUND" });
      products.push({ ref, assetType: item.assetType, id: item.id, code: null, name: null, weightPct, included: false, coverageDepth: null, presentRowCount: 0, declaredCount: null, asOfDate: null, holdingsCoveredPct: null });
      continue;
    }
    const label = basics.name ?? basics.code ?? ref;
    const snapshot = await getLatestSnapshot(item.assetType as ProductType, item.id);
    if (!snapshot || snapshot.rows.length === 0) {
      excludedProducts.push({ ref, label, name: basics.name, reason: "NO_HOLDINGS" });
      products.push({ ref, assetType: item.assetType, id: item.id, code: basics.code, name: basics.name, weightPct, included: false, coverageDepth: null, presentRowCount: 0, declaredCount: null, asOfDate: null, holdingsCoveredPct: null });
      continue;
    }
    const coverageDepth = coverageDepthOf(snapshot.source);
    if (coverageDepth !== "FULL") incompleteProducts.push({ ref, label, coverageDepth, presentRowCount: snapshot.rows.length, declaredCount: null });

    const rowsSumPct = snapshot.rows.reduce((acc, r) => acc + r.weightPct, 0);
    products.push({
      ref, assetType: item.assetType, id: item.id, code: basics.code, name: basics.name, weightPct, included: true,
      coverageDepth, presentRowCount: snapshot.rows.length, declaredCount: null, asOfDate: snapshot.asOfDate, holdingsCoveredPct: rowsSumPct,
    });
    lookedThroughPct += weightPct;

    for (const row of snapshot.rows) {
      const contributionPct = (weightPct * row.weightPct) / 100;
      const existing = stocks.get(row.key);
      if (existing) {
        existing.exposurePct += contributionPct;
        existing.holders.set(ref, (existing.holders.get(ref) ?? 0) + contributionPct);
      } else {
        stocks.set(row.key, { name: row.name, ticker: row.ticker, sector: row.sector, country: row.country, exposurePct: contributionPct, holders: new Map([[ref, contributionPct]]) });
      }
    }
  }

  const toStock = (agg: Agg, key: string) => ({
    name: agg.name, ticker: agg.ticker, exposurePct: agg.exposurePct, holderCount: agg.holders.size,
    contributions: [...agg.holders.entries()].map(([productRef, contributionPct]) => ({ productRef, label: products.find((p) => p.ref === productRef)?.name ?? productRef, contributionPct })),
    key,
  });
  const sortedStocks = [...stocks.entries()].map(([key, agg]) => toStock(agg, key)).sort((a, b) => b.exposurePct - a.exposurePct);
  const top10 = sortedStocks.slice(0, 10);
  const top20 = sortedStocks.slice(0, 20);
  const duplicateStocks = sortedStocks.filter((s) => s.holderCount > 1);
  const duplicatesExposurePct = duplicateStocks.reduce((acc, s) => acc + s.exposurePct, 0);

  function bucketBy(field: "sector" | "country"): { hasClassifiedData: boolean; largest: { label: string; exposurePct: number } | null; top3: Array<{ label: string; exposurePct: number }>; unclassifiedPct: number; all: Array<{ label: string; exposurePct: number }> } {
    const totals = new Map<string, number>();
    let unclassified = 0;
    for (const [, agg] of stocks) {
      const label = agg[field];
      if (!label) { unclassified += agg.exposurePct; continue; }
      totals.set(label, (totals.get(label) ?? 0) + agg.exposurePct);
    }
    const all = [...totals.entries()].map(([label, exposurePct]) => ({ label, exposurePct })).sort((a, b) => b.exposurePct - a.exposurePct);
    return { hasClassifiedData: all.length > 0, largest: all[0] ?? null, top3: all.slice(0, 3), unclassifiedPct: unclassified, all };
  }

  const notLookedThroughPct = Math.max(0, 100 - lookedThroughPct);
  return {
    ok: true,
    mode,
    itemCount: items.length,
    weights: { totalWeightPct: weightSumOk ? 100 : 0, totalAmount: mode === "AMOUNT" ? totalRaw : null, weightSumOk, warning: weightSumOk ? null : "尚未輸入有效的金額或比例" },
    products: products.map(({ ref, assetType, id, code, name, weightPct, included, coverageDepth, presentRowCount, declaredCount, asOfDate, holdingsCoveredPct }) => ({ ref, assetType, id, code, name, weightPct, included, coverageDepth, presentRowCount, declaredCount, asOfDate, holdingsCoveredPct })),
    completeness: {
      isPartialAnalysis: incompleteProducts.length > 0 || excludedProducts.length > 0,
      basisNote: incompleteProducts.length > 0 ? "部分標的僅公開前十大或部分持股，穿透結果可能低估實際曝險" : "基於可取得的完整持股計算",
      incompleteProducts, excludedProducts, excludedCount: excludedProducts.length,
      lookedThroughPct, notLookedThroughPct,
    },
    hasAnyHoldings: stocks.size > 0,
    stockExposure: {
      top10: top10.map(({ key: _key, ...rest }) => rest), top20: top20.map(({ key: _key, ...rest }) => rest),
      top10SumPct: top10.reduce((a, s) => a + s.exposurePct, 0), top20SumPct: top20.reduce((a, s) => a + s.exposurePct, 0),
      distinctStocks: stocks.size,
    },
    duplicates: {
      count: duplicateStocks.length, exposurePct: duplicatesExposurePct,
      shareOfLookedThroughPct: lookedThroughPct > 0 ? (duplicatesExposurePct / lookedThroughPct) * 100 : 0,
      top10: duplicateStocks.slice(0, 10).map(({ key: _key, ...rest }) => rest),
    },
    sector: bucketBy("sector"),
    country: bucketBy("country"),
  };
}
