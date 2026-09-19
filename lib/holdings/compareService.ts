// ETF/Fund side-by-side comparison. Performance/fee/risk/distribution come from the canonical
// etfs/funds columns as-is (null stays null — nothing is estimated). Holdings, concentration, diff and
// overlap are built ONLY from the existing holdings query layer and analysis functions, so depth
// labelling and conservative diff semantics are identical to the single-product holdings APIs.

import type { PrismaClient } from "@prisma/client";
import { computeConcentration } from "./concentration";
import type { CoverageDepth } from "./coverageDepth";
import { rekeyByNormalizedName } from "./holdingKey";
import { aggregateLookThroughExposure, summarizeOverlap, type ProductHoldings } from "./holdingsAnalysis";
import {
  getEtfHoldingsAsOf,
  getEtfHoldingsDiffLatestVsPrevious,
  getEtfHoldingsTableAsOf,
  getFundHoldingsAsOf,
  getFundHoldingsDiffLatestVsPrevious,
  getFundHoldingsTableAsOf,
} from "./holdingsQueries";

export const MIN_COMPARE = 2;
export const MAX_COMPARE = 4;

export type CompareKind = "ETF" | "FUND";
export type CompareRef = { kind: CompareKind; id: string };

const pct = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.round(n * 100 * 10000) / 10000;
};

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function parseCompareRefs(raw: string | null): CompareRef[] | { error: string } {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const refs: CompareRef[] = [];
  for (const part of parts) {
    const [k, ...rest] = part.split(":");
    const kind = k.toUpperCase();
    const id = rest.join(":");
    if ((kind !== "ETF" && kind !== "FUND") || !id) return { error: `INVALID_ITEM '${part}' — expected ETF:<id> or FUND:<id>` };
    if (!refs.some((r) => r.kind === kind && r.id === id)) refs.push({ kind, id });
  }
  if (refs.length < MIN_COMPARE) return { error: `NEED_AT_LEAST_${MIN_COMPARE}_ITEMS` };
  if (refs.length > MAX_COMPARE) return { error: `AT_MOST_${MAX_COMPARE}_ITEMS` };
  return refs;
}

async function loadProfile(prisma: PrismaClient, ref: CompareRef) {
  if (ref.kind === "ETF") {
    const e = await prisma.etf.findUnique({ where: { id: ref.id } });
    if (!e) return null;
    return {
      code: e.code as string | null,
      name: e.name,
      currency: e.currency,
      category: e.category ?? null,
      performance: { m1: num(e.return1m), m3: num(e.return3m), m6: num(e.return6m), ytd: num(e.returnYtd), y1: num(e.return1y), y3: num(e.return3y), y5: num(e.return5y) },
      fee: { expenseRatioPct: pct(e.expenseRatio) },
      risk: { volatility1yPct: num(e.volatility1y), sharpe1y: num(e.sharpe1y), beta: num(e.beta), maxDrawdownPct: num(e.maxDrawdown) },
      distribution: { frequency: e.distributionFreq ?? null, yieldPct: e.dividendYield != null && Number(e.dividendYield) === 0 && !e.distributionFreq ? null : pct(e.dividendYield) },
    };
  }
  const f = await prisma.fund.findUnique({ where: { id: ref.id } });
  if (!f) return null;
  return {
    code: (f.code ?? null) as string | null,
    name: f.name,
    currency: f.currency,
    category: null as string | null,
    // funds only carry 1Y+ returns in the canonical row; shorter periods stay null rather than guessed
    performance: { m1: null, m3: null, m6: null, ytd: null, y1: num(f.return1y), y3: num(f.return3y), y5: num(f.return5y) },
    fee: { expenseRatioPct: pct(f.expenseRatio) },
    risk: { volatility1yPct: num(f.volatility1y), sharpe1y: num(f.sharpe1y), beta: num(f.beta), maxDrawdownPct: num(f.maxDrawdown) },
    distribution: { frequency: f.distributionFreq ?? null, yieldPct: pct(f.dividendYieldA) ?? pct(f.dividendYieldM) },
  };
}

async function loadHoldingsBundle(prisma: PrismaClient, ref: CompareRef) {
  const isEtf = ref.kind === "ETF";
  const table = isEtf ? await getEtfHoldingsTableAsOf(prisma, ref.id) : await getFundHoldingsTableAsOf(prisma, ref.id);
  const asOfArg = table.asOfDate ?? undefined;
  const asOf = isEtf ? await getEtfHoldingsAsOf(prisma, ref.id, asOfArg) : await getFundHoldingsAsOf(prisma, ref.id, asOfArg);
  const diff = isEtf ? await getEtfHoldingsDiffLatestVsPrevious(prisma, ref.id) : await getFundHoldingsDiffLatestVsPrevious(prisma, ref.id);
  const c = computeConcentration(table.rows);
  const depth = table.coverage.coverage_depth as CoverageDepth;
  return {
    holdingsForOverlap: asOf as ProductHoldings,
    holdings: {
      asOfDate: table.asOfDate,
      source: table.source,
      coverageDepth: depth,
      isFullHoldings: table.coverage.is_full_holdings,
      presentRowCount: table.presentRowCount,
      declaredCount: table.declaredCount,
      top: table.rows.slice(0, 10).map((r) => ({ name: r.name, ticker: r.ticker, weightPct: r.weightPct })),
    },
    concentration: table.rows.length
      ? {
          top10Pct: c.top10Pct,
          top20Pct: c.top20Pct,
          largest: c.largestHolding ? { name: c.largestHolding.name, weightPct: c.largestHolding.weightPct } : null,
          topSectors: c.sectorConcentration.slice(0, 3),
          topCountries: c.countryConcentration.slice(0, 3),
        }
      : null,
    diff: !diff.hasEnoughHistory
      ? { hasEnoughHistory: false as const, latestDate: diff.latestDate }
      : {
          hasEnoughHistory: true as const,
          previousDate: diff.previousDate,
          latestDate: diff.latestDate,
          comparabilityLevel: diff.comparability?.level ?? null,
          warning: diff.comparability?.warning ?? null,
          counts: {
            added: diff.entries.filter((e) => e.change === "ADDED").length,
            increased: diff.entries.filter((e) => e.change === "INCREASED").length,
            decreased: diff.entries.filter((e) => e.change === "DECREASED").length,
            removed: diff.entries.filter((e) => e.change === "REMOVED").length,
            newlyDisclosed: diff.newlyDisclosed.length,
            noLongerDisclosed: diff.noLongerDisclosed.length,
          },
          topMoves: diff.entries
            .filter((e) => e.change === "INCREASED" || e.change === "DECREASED")
            .sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))
            .slice(0, 3)
            .map((e) => ({ name: e.name, deltaPct: e.deltaPct })),
        },
  };
}

/**
 * Pairwise overlap through the existing look-through aggregation (two products at equal allocation).
 * Positions are matched on normalized holding NAME so a ticker-keyed ETF and a name-keyed fund can
 * still be compared; overlapWeightPct = sum over shared positions of min(weight in A, weight in B).
 */
export function pairOverlap(a: ProductHoldings, b: ProductHoldings) {
  const rekey = (p: ProductHoldings): ProductHoldings => ({ ...p, holdings: rekeyByNormalizedName(p.holdings) });
  const exposure = aggregateLookThroughExposure(
    [
      { productId: a.productId, allocationPct: 50 },
      { productId: b.productId, allocationPct: 50 },
    ],
    new Map([
      [a.productId, rekey(a)],
      [b.productId, rekey(b)],
    ]),
  );
  const summary = summarizeOverlap(exposure);
  const shared = exposure.filter((e) => e.contributingProducts.length > 1);
  const side = (e: (typeof shared)[number], id: string) => (e.contributingProducts.find((p) => p.productId === id)?.contributionPct ?? 0) * 2;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const overlapWeightPct = shared.reduce((s, e) => s + Math.min(side(e, a.productId), side(e, b.productId)), 0);
  return {
    sharedCount: summary.sharedPositions,
    overlapWeightPct: round2(overlapWeightPct),
    topShared: shared.slice(0, 5).map((e) => ({ name: e.name, weightA: round2(side(e, a.productId)), weightB: round2(side(e, b.productId)) })),
  };
}

export async function buildCompare(prisma: PrismaClient, refs: CompareRef[]) {
  const loaded = await Promise.all(
    refs.map(async (ref) => ({ ref, profile: await loadProfile(prisma, ref), bundle: await loadHoldingsBundle(prisma, ref) })),
  );
  const items = loaded.map(({ ref, profile, bundle }) => ({
    assetType: ref.kind,
    id: ref.id,
    found: profile != null,
    code: profile?.code ?? null,
    name: profile?.name ?? null,
    currency: profile?.currency ?? null,
    category: profile?.category ?? null,
    performance: profile?.performance ?? null,
    fee: profile?.fee ?? null,
    risk: profile?.risk ?? null,
    distribution: profile?.distribution ?? null,
    holdings: bundle.holdings,
    concentration: bundle.concentration,
    holdingsDiff: bundle.diff,
  }));
  const overlaps = [];
  for (let i = 0; i < loaded.length; i++) {
    for (let j = i + 1; j < loaded.length; j++) {
      const A = loaded[i];
      const B = loaded[j];
      const depthA = A.bundle.holdings.coverageDepth;
      const depthB = B.bundle.holdings.coverageDepth;
      const empty = A.bundle.holdingsForOverlap.holdings.length === 0 || B.bundle.holdingsForOverlap.holdings.length === 0;
      overlaps.push({
        a: { assetType: A.ref.kind, id: A.ref.id },
        b: { assetType: B.ref.kind, id: B.ref.id },
        available: !empty,
        ...(empty ? { sharedCount: null, overlapWeightPct: null, topShared: [] } : pairOverlap(A.bundle.holdingsForOverlap, B.bundle.holdingsForOverlap)),
        basis: { aDepth: depthA, bDepth: depthB, aRows: A.bundle.holdings.presentRowCount, bRows: B.bundle.holdings.presentRowCount },
        basedOnAvailableDataOnly: !(depthA === "FULL" && depthB === "FULL"),
      });
    }
  }
  return { ok: true, count: items.length, items, overlaps };
}
