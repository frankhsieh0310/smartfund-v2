// Portfolio look-through for up to 10 ETF/Fund positions. No second holdings engine: positions are
// loaded through lib/holdings/holdingsQueries (dated-first snapshot, single-source fund rows, FULL/
// PARTIAL/TOP_N labelling) and aggregated with the existing look-through / overlap functions in
// holdingsAnalysis.ts and the existing sector/country buckets in concentration.ts.

import type { PrismaClient } from "@prisma/client";
import { computeConcentration } from "./concentration";
import type { CoverageDepth } from "./coverageDepth";
import { rekeyByNormalizedName, normalizeHoldingName } from "./holdingKey";
import { aggregateLookThroughExposure, summarizeOverlap, type ProductHoldings } from "./holdingsAnalysis";
import { loadEtfSectorAllocations, sectorLabel, type SectorAllocation } from "./sectorAllocation";
import { getEtfHoldingsTableAsOf, getFundHoldingsTableAsOf, type HoldingsTableRow } from "./holdingsQueries";

export const MAX_PORTFOLIO_ITEMS = 10;
export type PortfolioMode = "AMOUNT" | "WEIGHT";
export type PortfolioKind = "ETF" | "FUND";
export type PortfolioInputItem = { kind: PortfolioKind; id: string; value: number };

export function parsePortfolioParams(itemsRaw: string | null, modeRaw: string | null): { items: PortfolioInputItem[]; mode: PortfolioMode } | { error: string } {
  const mode = (modeRaw ?? "").toUpperCase();
  if (mode !== "AMOUNT" && mode !== "WEIGHT") return { error: "INVALID_MODE — expected AMOUNT or WEIGHT" };
  const items: PortfolioInputItem[] = [];
  for (const part of (itemsRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, id, v] = part.split(":");
    const kind = (k ?? "").toUpperCase();
    const value = Number(v);
    if ((kind !== "ETF" && kind !== "FUND") || !id) return { error: `INVALID_ITEM '${part}' — expected ETF|FUND:<id>:<value>` };
    if (!Number.isFinite(value) || value <= 0) return { error: `INVALID_VALUE '${part}' — value must be a positive number` };
    if (items.some((i) => i.kind === kind && i.id === id)) return { error: `DUPLICATE_ITEM '${part}'` };
    items.push({ kind, id, value });
  }
  if (items.length < 1) return { error: "NEED_AT_LEAST_1_ITEM" };
  if (items.length > MAX_PORTFOLIO_ITEMS) return { error: `AT_MOST_${MAX_PORTFOLIO_ITEMS}_ITEMS` };
  return { items, mode };
}

/** Product as loaded from the holdings layer (rows are null-safe: empty rows = no holdings). */
export type LoadedProduct = {
  ref: string; // `${kind}:${id}`
  kind: PortfolioKind;
  id: string;
  name: string | null;
  code: string | null;
  found: boolean;
  weightPct: number; // portfolio weight as the user entered / derived from amounts (never re-normalized)
  rows: HoldingsTableRow[];
  coverageDepth: CoverageDepth;
  isFullHoldings: boolean;
  presentRowCount: number;
  declaredCount: number | null;
  asOfDate: string | null;
  source: string | null;
};

const round = (n: number, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
const UNCLASSIFIED = "Unclassified";

export function computeWeights(items: PortfolioInputItem[], mode: PortfolioMode) {
  const sum = items.reduce((s, i) => s + i.value, 0);
  const weights = items.map((i) => (mode === "AMOUNT" ? (i.value / sum) * 100 : i.value));
  const totalWeightPct = round(weights.reduce((s, w) => s + w, 0), 4);
  const weightSumOk = mode === "AMOUNT" || Math.abs(totalWeightPct - 100) <= 0.01;
  return {
    weights,
    totalWeightPct,
    totalAmount: mode === "AMOUNT" ? sum : null,
    weightSumOk,
    weightWarning: weightSumOk ? null : `配置比例總和為 ${round(totalWeightPct, 2)}%，不是 100%。分析依你輸入的比例計算，未自動修正。`,
  };
}

export function analyzePortfolio(
  products: LoadedProduct[],
  mode: PortfolioMode,
  weightInfo: Omit<ReturnType<typeof computeWeights>, "weights">,
  sectorAlloc: Map<string, SectorAllocation> = new Map(), // key: LoadedProduct.ref
) {
  const label = (p: LoadedProduct) => p.code ?? p.name ?? p.id.slice(0, 6);
  const included = products.filter((p) => p.found && p.rows.length > 0);
  const excluded = products.filter((p) => !included.includes(p));
  const incomplete = included.filter((p) => p.coverageDepth !== "FULL");

  // ---- look-through through the existing aggregation (allocation % × holding weight %) ----
  const byProduct = new Map<string, ProductHoldings>();
  const meta = new Map<string, { ticker: string | null; sector: string | null; country: string | null }>();
  for (const p of included) {
    byProduct.set(p.ref, { productId: p.ref, asOfDate: p.asOfDate, holdings: rekeyByNormalizedName(p.rows.map((r) => ({ key: r.key, name: r.name, weightPct: r.weightPct }))) });
    for (const r of p.rows) {
      const key = normalizeHoldingName(r.name);
      const cur = meta.get(key);
      meta.set(key, { ticker: cur?.ticker ?? r.ticker ?? null, sector: cur?.sector ?? r.sector ?? null, country: cur?.country ?? r.country ?? null });
    }
  }
  const exposure = aggregateLookThroughExposure(
    included.map((p) => ({ productId: p.ref, allocationPct: p.weightPct })),
    byProduct,
  );
  const labelOf = new Map(included.map((p) => [p.ref, label(p)]));
  const toStock = (e: (typeof exposure)[number]) => ({
    name: e.name,
    ticker: meta.get(e.key)?.ticker ?? null,
    exposurePct: round(e.effectiveWeightPct),
    holderCount: e.contributingProducts.length,
    contributions: [...e.contributingProducts]
      .sort((a, b) => b.contributionPct - a.contributionPct)
      .map((c) => ({ productRef: c.productId, label: labelOf.get(c.productId) ?? c.productId, contributionPct: round(c.contributionPct) })),
  });
  const top = (n: number) => exposure.slice(0, n).map(toStock);
  const sumTop = (n: number) => round(exposure.slice(0, n).reduce((s, e) => s + e.effectiveWeightPct, 0));

  // ---- duplicates: same stock held by 2+ products ----
  const shared = exposure.filter((e) => e.contributingProducts.length > 1);
  const overlapSummary = summarizeOverlap(exposure);
  const duplicateExposurePct = round(shared.reduce((s, e) => s + e.effectiveWeightPct, 0));

  // ---- sector: ETF product-level allocation x portfolio weight (etf_sector_allocations). Never guessed. ----
  const rankBuckets = (totals: Map<string, number>, labelOf: (k: string) => string) =>
    [...totals.entries()].map(([key, exposurePct]) => ({ key, label: labelOf(key), exposurePct: round(exposurePct) })).sort((a, b) => b.exposurePct - a.exposurePct);
  const sectorTotals = new Map<string, number>();
  const sectorCoverage = products.map((p) => {
    const alloc = p.kind === "ETF" && p.found ? sectorAlloc.get(p.ref) : undefined;
    if (alloc) for (const b of alloc.buckets) sectorTotals.set(b.key, (sectorTotals.get(b.key) ?? 0) + (p.weightPct / 100) * b.weightPct);
    return {
      ref: p.ref, label: label(p), weightPct: round(p.weightPct, 4),
      status: !p.found ? "NOT_FOUND" : alloc ? "COVERED" : p.kind === "FUND" ? "FUND_SECTOR_UNAVAILABLE" : "NO_SECTOR_ALLOCATION",
      asOfDate: alloc?.asOfDate ?? null, source: alloc?.source ?? null,
      sectorCoveredPct: alloc ? round(alloc.coveredPct) : null,
      contributesPortfolioPct: alloc ? round((p.weightPct / 100) * alloc.coveredPct) : 0,
    };
  });
  const sectorAll = rankBuckets(sectorTotals, sectorLabel);
  const sectorClassifiedPct = round(sectorAll.reduce((t, b) => t + b.exposurePct, 0));
  const sectorUncovered = round(Math.max(0, weightInfo.totalWeightPct - sectorClassifiedPct));
  const sector = {
    hasClassifiedData: sectorAll.length > 0,
    largest: sectorAll[0] ?? null,
    top3: sectorAll.slice(0, 3),
    all: sectorAll,
    calculatedPct: sectorClassifiedPct,
    uncoveredPct: sectorUncovered,
    unclassifiedPct: sectorUncovered,
    coveredProductCount: sectorCoverage.filter((c) => c.status === "COVERED").length,
    uncoveredProducts: sectorCoverage.filter((c) => c.status !== "COVERED"),
    sourceCoverage: sectorCoverage,
    basisNote: "產業曝險 = 各 ETF 的投組權重 × 該 ETF 公布的產業配置；沒有產業配置資料的商品列為未涵蓋，不推測。",
  };

  // ---- country: only real per-holding country values from the looked-through holdings ----
  const countryTotals = new Map<string, number>();
  const countryCoverage = products.map((p) => {
    const isIncluded = included.includes(p);
    let classified = 0;
    if (isIncluded) {
      for (const b of computeConcentration(p.rows).countryConcentration) {
        if (b.label === UNCLASSIFIED) continue;
        classified += b.weightPct;
        countryTotals.set(b.label, (countryTotals.get(b.label) ?? 0) + (p.weightPct / 100) * b.weightPct);
      }
    }
    return {
      ref: p.ref, label: label(p), weightPct: round(p.weightPct, 4),
      status: !isIncluded ? "NO_HOLDINGS" : classified > 0 ? "COVERED" : "NO_COUNTRY_DATA",
      countryCoveredPct: isIncluded ? round(classified) : null,
      contributesPortfolioPct: round((p.weightPct / 100) * classified),
    };
  });
  const countryAll = rankBuckets(countryTotals, (k) => k);
  const countryClassifiedPct = round(countryAll.reduce((t, b) => t + b.exposurePct, 0));
  const countryUncovered = round(Math.max(0, weightInfo.totalWeightPct - countryClassifiedPct));
  const country = {
    hasClassifiedData: countryAll.length > 0,
    largest: countryAll[0] ?? null,
    top3: countryAll.slice(0, 3),
    all: countryAll,
    calculatedPct: countryClassifiedPct,
    uncoveredPct: countryUncovered,
    unclassifiedPct: countryUncovered,
    coveredProductCount: countryCoverage.filter((c) => c.status === "COVERED").length,
    sourceCoverage: countryCoverage,
    basisNote: "國家曝險僅計入持股資料中有標示國家的部分；未標示者列為未涵蓋，不推測。",
  };
  const lookedThroughPct = round(included.reduce((s, p) => s + (p.weightPct / 100) * p.rows.reduce((t, r) => t + r.weightPct, 0), 0));

  const isPartialAnalysis = incomplete.length > 0 || excluded.length > 0;
  const describe = (p: LoadedProduct) => ({
    ref: p.ref, assetType: p.kind, id: p.id, code: p.code, name: p.name, weightPct: round(p.weightPct, 4),
    included: included.includes(p), coverageDepth: p.rows.length ? p.coverageDepth : null,
    presentRowCount: p.presentRowCount, declaredCount: p.declaredCount, asOfDate: p.asOfDate, source: p.source,
    holdingsCoveredPct: p.rows.length ? round(p.rows.reduce((s, r) => s + r.weightPct, 0)) : null,
  });

  return {
    ok: true,
    mode,
    itemCount: products.length,
    weights: { totalWeightPct: weightInfo.totalWeightPct, totalAmount: weightInfo.totalAmount, weightSumOk: weightInfo.weightSumOk, warning: weightInfo.weightWarning },
    products: products.map(describe),
    completeness: {
      isPartialAnalysis,
      basisNote: isPartialAnalysis ? "依目前可取得持股估算（非完整穿透）" : "基於完整持股計算",
      incompleteProducts: incomplete.map((p) => ({ ref: p.ref, label: label(p), coverageDepth: p.coverageDepth, presentRowCount: p.presentRowCount, declaredCount: p.declaredCount })),
      excludedProducts: excluded.map((p) => ({ ref: p.ref, label: label(p), name: p.name, reason: p.found ? "NO_HOLDINGS" : "NOT_FOUND" })),
      excludedCount: excluded.length,
      lookedThroughPct,
      notLookedThroughPct: round(weightInfo.totalWeightPct - lookedThroughPct),
    },
    hasAnyHoldings: included.length > 0,
    stockExposure: { top10: top(10), top20: top(20), top10SumPct: sumTop(10), top20SumPct: sumTop(20), distinctStocks: exposure.length },
    duplicates: {
      count: overlapSummary.sharedPositions,
      exposurePct: duplicateExposurePct,
      shareOfLookedThroughPct: overlapSummary.overlapPct,
      top10: shared.slice(0, 10).map(toStock),
    },
    sector,
    country,
  };
}

export async function buildPortfolioAnalysis(prisma: PrismaClient, items: PortfolioInputItem[], mode: PortfolioMode) {
  const { weights, ...weightInfo } = computeWeights(items, mode);
  const products: LoadedProduct[] = await Promise.all(
    items.map(async (item, index) => {
      const isEtf = item.kind === "ETF";
      const profile = isEtf
        ? await prisma.etf.findUnique({ where: { id: item.id }, select: { code: true, name: true } })
        : await prisma.fund.findUnique({ where: { id: item.id }, select: { code: true, name: true } });
      const view = profile ? (isEtf ? await getEtfHoldingsTableAsOf(prisma, item.id) : await getFundHoldingsTableAsOf(prisma, item.id)) : null;
      return {
        ref: `${item.kind}:${item.id}`, kind: item.kind, id: item.id,
        name: profile?.name ?? null, code: (profile?.code ?? null) as string | null, found: profile != null,
        weightPct: weights[index],
        rows: view?.rows ?? [],
        coverageDepth: (view?.coverage.coverage_depth ?? "UNKNOWN") as CoverageDepth,
        isFullHoldings: view?.coverage.is_full_holdings ?? false,
        presentRowCount: view?.presentRowCount ?? 0, declaredCount: view?.declaredCount ?? null,
        asOfDate: view?.asOfDate ?? null, source: view?.source ?? null,
      };
    }),
  );
  const etfIds = products.filter((p) => p.kind === "ETF" && p.found).map((p) => p.id);
  const alloc = await loadEtfSectorAllocations(prisma, etfIds);
  const byRef = new Map<string, SectorAllocation>();
  for (const p of products) { const a = alloc.get(p.id); if (a && p.kind === "ETF") byRef.set(p.ref, a); }
  return analyzePortfolio(products, mode, weightInfo, byRef);
}
