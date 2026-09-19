// Pure, DB-free holdings analysis foundation. No UI, no alerts, no API route — just the shared
// computation any future feature (diff view, overlap screen, look-through, what-if) would call into.
// Every function here takes plain data in and returns plain data out.

export type HoldingRow = {
  key: string; // stable identity for one underlying position (ticker, or securityId, or isin — caller's choice, must be consistent across both sides of a diff/aggregation)
  name: string;
  weightPct: number; // weight of this holding WITHIN its own product, 0-100
};

export type ProductHoldings = {
  productId: string;
  asOfDate: string | null;
  holdings: HoldingRow[];
};

// ---- 1) Two-period snapshot diff ----

export type HoldingsDiffEntry = {
  key: string;
  name: string;
  oldWeightPct: number | null;
  newWeightPct: number | null;
  deltaPct: number | null;
  change: "ADDED" | "REMOVED" | "INCREASED" | "DECREASED" | "UNCHANGED";
};

/** Compares two dated holdings snapshots of the SAME product and classifies every position. */
export function diffHoldingsSnapshots(
  oldRows: HoldingRow[],
  newRows: HoldingRow[],
  epsilonPct = 0.01,
): HoldingsDiffEntry[] {
  const oldByKey = new Map(oldRows.map((r) => [r.key, r]));
  const newByKey = new Map(newRows.map((r) => [r.key, r]));
  const keys = new Set([...oldByKey.keys(), ...newByKey.keys()]);
  const entries: HoldingsDiffEntry[] = [];
  for (const key of keys) {
    const before = oldByKey.get(key) ?? null;
    const after = newByKey.get(key) ?? null;
    const name = after?.name ?? before?.name ?? key;
    if (!before && after) {
      entries.push({ key, name, oldWeightPct: null, newWeightPct: after.weightPct, deltaPct: after.weightPct, change: "ADDED" });
    } else if (before && !after) {
      entries.push({ key, name, oldWeightPct: before.weightPct, newWeightPct: null, deltaPct: -before.weightPct, change: "REMOVED" });
    } else if (before && after) {
      const delta = after.weightPct - before.weightPct;
      const change = Math.abs(delta) <= epsilonPct ? "UNCHANGED" : delta > 0 ? "INCREASED" : "DECREASED";
      entries.push({ key, name, oldWeightPct: before.weightPct, newWeightPct: after.weightPct, deltaPct: delta, change });
    }
  }
  return entries.sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0));
}

// ---- 2) Multi-fund/ETF holdings aggregation + 3) look-through (weight x weight) ----

export type PortfolioAllocation = {
  productId: string;
  allocationPct: number; // this product's weight WITHIN the portfolio being analyzed, 0-100
};

export type AggregatedExposure = {
  key: string;
  name: string;
  effectiveWeightPct: number; // sum over products of (allocationPct/100 * holdingWeightPct)
  contributingProducts: Array<{ productId: string; contributionPct: number }>;
};

/**
 * Look-through: given a portfolio of product allocations and each product's own holdings, compute
 * the effective underlying exposure per position. Also directly answers "multi-fund overlap" — any
 * key with more than one entry in contributingProducts is held by more than one selected product.
 */
export function aggregateLookThroughExposure(
  portfolio: PortfolioAllocation[],
  productHoldingsById: Map<string, ProductHoldings>,
): AggregatedExposure[] {
  const byKey = new Map<string, AggregatedExposure>();
  for (const alloc of portfolio) {
    const product = productHoldingsById.get(alloc.productId);
    if (!product) continue;
    for (const h of product.holdings) {
      const contribution = (alloc.allocationPct / 100) * h.weightPct;
      if (contribution <= 0) continue;
      const existing = byKey.get(h.key);
      if (existing) {
        existing.effectiveWeightPct += contribution;
        existing.contributingProducts.push({ productId: alloc.productId, contributionPct: contribution });
      } else {
        byKey.set(h.key, {
          key: h.key,
          name: h.name,
          effectiveWeightPct: contribution,
          contributingProducts: [{ productId: alloc.productId, contributionPct: contribution }],
        });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.effectiveWeightPct - a.effectiveWeightPct);
}

/** Overlap summary derived from the same aggregation — no separate pass needed. */
export function summarizeOverlap(exposure: AggregatedExposure[]): {
  sharedPositions: number;
  totalPositions: number;
  overlapPct: number; // share of aggregate effective weight sitting in positions held by 2+ products
} {
  const shared = exposure.filter((e) => e.contributingProducts.length > 1);
  const totalWeight = exposure.reduce((s, e) => s + e.effectiveWeightPct, 0);
  const sharedWeight = shared.reduce((s, e) => s + e.effectiveWeightPct, 0);
  return {
    sharedPositions: shared.length,
    totalPositions: exposure.length,
    overlapPct: totalWeight > 0 ? Math.round((sharedWeight / totalWeight) * 1000) / 10 : 0,
  };
}

// ---- 4) What-if recompute ----

export type WhatIfChange = {
  add?: PortfolioAllocation[];
  remove?: string[]; // productIds to drop from the base portfolio
};

export type WhatIfResult = {
  before: AggregatedExposure[];
  after: AggregatedExposure[];
  beforeOverlap: ReturnType<typeof summarizeOverlap>;
  afterOverlap: ReturnType<typeof summarizeOverlap>;
  exposureDelta: HoldingsDiffEntry[]; // reuses the same diff shape, keyed on effective weight instead of a single product's weight
};

/** Pure recompute of a portfolio with a product added/removed — no DB write, no persisted state. */
export function whatIfPortfolio(
  basePortfolio: PortfolioAllocation[],
  change: WhatIfChange,
  productHoldingsById: Map<string, ProductHoldings>,
): WhatIfResult {
  const before = aggregateLookThroughExposure(basePortfolio, productHoldingsById);
  const removeSet = new Set(change.remove ?? []);
  const nextPortfolio = [...basePortfolio.filter((p) => !removeSet.has(p.productId)), ...(change.add ?? [])];
  const after = aggregateLookThroughExposure(nextPortfolio, productHoldingsById);

  const beforeAsRows: HoldingRow[] = before.map((e) => ({ key: e.key, name: e.name, weightPct: e.effectiveWeightPct }));
  const afterAsRows: HoldingRow[] = after.map((e) => ({ key: e.key, name: e.name, weightPct: e.effectiveWeightPct }));

  return {
    before,
    after,
    beforeOverlap: summarizeOverlap(before),
    afterOverlap: summarizeOverlap(after),
    exposureDelta: diffHoldingsSnapshots(beforeAsRows, afterAsRows),
  };
}
