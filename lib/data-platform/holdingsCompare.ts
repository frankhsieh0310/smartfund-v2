// Task X12 (round-6 instruction 四-8): backend for the App's EtfFundCompareSection, which has existed
// since before this QA engagement calling /api/holdings/compare -- a route that was never built, so
// the section was hidden. Builds it now by composing the SAME services the already-live
// /api/holdings/[type]/[id]/{table,concentration,diff} routes use (getLatestSnapshot,
// getTwoLatestSnapshots, coverageDepthOf) plus direct reads of etfs/funds and
// etf_performances/fund_performances -- no new pipeline, no new table, every field traces to a
// column that already exists and is already written by an existing, already-verified source.
import { prisma } from "@/lib/prisma";
import { getLatestSnapshot, getTwoLatestSnapshots, coverageDepthOf, type ProductType, type CoverageDepth } from "./holdingsHistory";

export type CompareKind = "ETF" | "FUND";
export type CompareRef = { assetType: CompareKind; id: string };

export type CompareItem = {
  assetType: CompareKind;
  id: string;
  found: boolean;
  code: string | null;
  name: string | null;
  currency: string | null;
  performance: { m1: number | null; m3: number | null; m6: number | null; ytd: number | null; y1: number | null; y3: number | null; y5: number | null } | null;
  fee: { expenseRatioPct: number | null } | null;
  risk: { volatility1yPct: number | null; sharpe1y: number | null; beta: number | null; maxDrawdownPct: number | null } | null;
  distribution: { frequency: string | null; yieldPct: number | null } | null;
  holdings: {
    asOfDate: string | null;
    source: string | null;
    coverageDepth: CoverageDepth;
    isFullHoldings: boolean;
    presentRowCount: number;
    declaredCount: number | null;
    top: Array<{ name: string; ticker: string | null; weightPct: number }>;
  };
  concentration: { top10Pct: number; top20Pct: number; largest: { name: string; weightPct: number } | null } | null;
  holdingsDiff:
    | { hasEnoughHistory: false; latestDate: string | null }
    | {
        hasEnoughHistory: true;
        previousDate: string | null;
        latestDate: string | null;
        comparabilityLevel: "FULL_VS_FULL" | "CONSERVATIVE" | null;
        warning: string | null;
        counts: { added: number; increased: number; decreased: number; removed: number; newlyDisclosed: number; noLongerDisclosed: number };
        topMoves: Array<{ name: string; deltaPct: number | null }>;
      };
};

export type CompareOverlap = {
  a: CompareRef;
  b: CompareRef;
  available: boolean;
  sharedCount: number | null;
  overlapWeightPct: number | null;
  topShared: Array<{ name: string; weightA: number; weightB: number }>;
  basis: { aDepth: CoverageDepth; bDepth: CoverageDepth; aRows: number; bRows: number };
  basedOnAvailableDataOnly: boolean;
};

export type EtfFundCompareResponse = { ok: boolean; count: number; items: CompareItem[]; overlaps: CompareOverlap[] };

async function fetchBasics(assetType: CompareKind, id: string): Promise<{ code: string | null; name: string | null; currency: string | null; expenseRatio: number | null } | null> {
  const table = assetType === "ETF" ? "etfs" : "funds";
  const rows = await prisma.$queryRawUnsafe<Array<{ code: string | null; name: string | null; currency: string | null; expense_ratio: string | null }>>(
    `SELECT code, name, currency, expense_ratio::text AS expense_ratio FROM ${table} WHERE id = $1`,
    id,
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { code: r.code, name: r.name, currency: r.currency, expenseRatio: r.expense_ratio == null ? null : Number(r.expense_ratio) };
}

async function fetchPerformance(assetType: CompareKind, id: string) {
  const table = assetType === "ETF" ? "etf_performances" : "fund_performances";
  const col = assetType === "ETF" ? "etf_id" : "fund_id";
  const rows = await prisma.$queryRawUnsafe<Array<{
    return_1m: string | null; return_3m: string | null; return_6m: string | null; return_ytd: string | null;
    return_1y: string | null; return_3y: string | null; return_5y: string | null;
    volatility: string | null; sharpe: string | null; beta: string | null; max_drawdown: string | null; dividend_yield: string | null;
  }>>(
    `SELECT return_1m::text, return_3m::text, return_6m::text, return_ytd::text, return_1y::text, return_3y::text, return_5y::text,
            volatility::text, sharpe::text, beta::text, max_drawdown::text, dividend_yield::text
       FROM ${table} WHERE ${col} = $1 ORDER BY date DESC LIMIT 1`,
    id,
  );
  if (!rows.length) return null;
  const r = rows[0];
  const n = (v: string | null) => (v == null ? null : Number(v));
  return {
    performance: { m1: n(r.return_1m), m3: n(r.return_3m), m6: n(r.return_6m), ytd: n(r.return_ytd), y1: n(r.return_1y), y3: n(r.return_3y), y5: n(r.return_5y) },
    risk: { volatility1yPct: n(r.volatility), sharpe1y: n(r.sharpe), beta: n(r.beta), maxDrawdownPct: n(r.max_drawdown) },
    distributionYieldPct: n(r.dividend_yield),
  };
}

// The generic `distributions` table (product_id/frequency/yield_rate) is the only one of the several
// distribution-related tables that isn't ETF- or fund-specific in schema shape, used here only for
// `frequency` (yield itself comes from the performance table above, already used and verified by the
// 配息率排行榜 ranking page). A missing row just means frequency stays null -- never fabricated.
async function fetchDistributionFrequency(assetType: CompareKind, id: string): Promise<string | null> {
  const col = assetType === "ETF" ? "etf_id" : "fund_id";
  const rows = await prisma.$queryRawUnsafe<Array<{ frequency: string | null }>>(
    `SELECT frequency FROM distributions WHERE ${col} = $1 ORDER BY ex_date DESC LIMIT 1`,
    id,
  );
  return rows[0]?.frequency ?? null;
}

function bucketTop(rows: Array<{ weightPct: number }>, n: number) {
  return rows.reduce((acc, r) => acc + r.weightPct, 0) === 0 ? 0 : [...rows].sort((a, b) => b.weightPct - a.weightPct).slice(0, n).reduce((acc, r) => acc + r.weightPct, 0);
}

export async function compareEtfFund(refs: CompareRef[]): Promise<EtfFundCompareResponse> {
  const items: CompareItem[] = [];
  const snapshotsByRef = new Map<string, { latest: Awaited<ReturnType<typeof getLatestSnapshot>>; diff: Awaited<ReturnType<typeof getTwoLatestSnapshots>> }>();

  for (const ref of refs) {
    const productType = ref.assetType as ProductType;
    const basics = await fetchBasics(ref.assetType, ref.id);
    if (!basics) {
      items.push({
        assetType: ref.assetType, id: ref.id, found: false, code: null, name: null, currency: null,
        performance: null, fee: null, risk: null, distribution: null,
        holdings: { asOfDate: null, source: null, coverageDepth: "UNKNOWN", isFullHoldings: false, presentRowCount: 0, declaredCount: null, top: [] },
        concentration: null, holdingsDiff: { hasEnoughHistory: false, latestDate: null },
      });
      continue;
    }
    const perf = await fetchPerformance(ref.assetType, ref.id);
    const frequency = await fetchDistributionFrequency(ref.assetType, ref.id);
    const latest = await getLatestSnapshot(productType, ref.id);
    const diff = await getTwoLatestSnapshots(productType, ref.id);
    snapshotsByRef.set(`${ref.assetType}:${ref.id}`, { latest, diff });

    const coverageDepth = coverageDepthOf(latest?.source ?? null);
    const sorted = latest ? [...latest.rows].sort((a, b) => b.weightPct - a.weightPct) : [];

    let holdingsDiff: CompareItem["holdingsDiff"];
    if (!diff.previous) {
      holdingsDiff = { hasEnoughHistory: false, latestDate: diff.latest || null };
    } else {
      const prevMap = new Map(diff.previousRows.map((r) => [r.key, r]));
      const latestMap = new Map(diff.latestRows.map((r) => [r.key, r]));
      const allKeys = new Set([...prevMap.keys(), ...latestMap.keys()]);
      let added = 0, increased = 0, decreased = 0, removed = 0;
      const moves: Array<{ name: string; deltaPct: number }> = [];
      for (const key of allKeys) {
        const prev = prevMap.get(key);
        const cur = latestMap.get(key);
        if (!prev && cur) { added++; moves.push({ name: cur.name, deltaPct: cur.weightPct }); }
        else if (prev && !cur) { removed++; moves.push({ name: prev.name, deltaPct: -prev.weightPct }); }
        else if (prev && cur) {
          const delta = cur.weightPct - prev.weightPct;
          if (delta > 0.001) { increased++; moves.push({ name: cur.name, deltaPct: delta }); }
          else if (delta < -0.001) { decreased++; moves.push({ name: cur.name, deltaPct: delta }); }
        }
      }
      moves.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
      const prevDepth = coverageDepthOf(diff.previousSource);
      holdingsDiff = {
        hasEnoughHistory: true,
        previousDate: diff.previous, latestDate: diff.latest,
        comparabilityLevel: coverageDepth === "FULL" && prevDepth === "FULL" ? "FULL_VS_FULL" : "CONSERVATIVE",
        warning: coverageDepth === "FULL" && prevDepth === "FULL" ? null : "其中一期不是完整持股，異動比較僅供參考",
        counts: { added, increased, decreased, removed, newlyDisclosed: 0, noLongerDisclosed: 0 },
        topMoves: moves.slice(0, 10).map((m) => ({ name: m.name, deltaPct: m.deltaPct })),
      };
    }

    items.push({
      assetType: ref.assetType, id: ref.id, found: true,
      code: basics.code, name: basics.name, currency: basics.currency,
      performance: perf?.performance ?? null,
      fee: { expenseRatioPct: basics.expenseRatio },
      risk: perf?.risk ?? null,
      distribution: { frequency, yieldPct: perf?.distributionYieldPct ?? null },
      holdings: {
        asOfDate: latest?.asOfDate ?? null, source: latest?.source ?? null, coverageDepth,
        isFullHoldings: coverageDepth === "FULL", presentRowCount: sorted.length, declaredCount: null,
        top: sorted.slice(0, 10).map((r) => ({ name: r.name, ticker: r.ticker, weightPct: r.weightPct })),
      },
      concentration: latest ? { top10Pct: bucketTop(sorted, 10), top20Pct: bucketTop(sorted, 20), largest: sorted[0] ? { name: sorted[0].name, weightPct: sorted[0].weightPct } : null } : null,
      holdingsDiff,
    });
  }

  // Pairwise overlaps: only between items that were actually found and have at least one holdings row.
  const overlaps: CompareOverlap[] = [];
  const found = items.filter((i) => i.found);
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length; j++) {
      const a = found[i], b = found[j];
      const snapA = snapshotsByRef.get(`${a.assetType}:${a.id}`)?.latest;
      const snapB = snapshotsByRef.get(`${b.assetType}:${b.id}`)?.latest;
      const aRef: CompareRef = { assetType: a.assetType, id: a.id };
      const bRef: CompareRef = { assetType: b.assetType, id: b.id };
      if (!snapA || !snapB || snapA.rows.length === 0 || snapB.rows.length === 0) {
        overlaps.push({
          a: aRef, b: bRef, available: false, sharedCount: null, overlapWeightPct: null, topShared: [],
          basis: { aDepth: a.holdings.coverageDepth, bDepth: b.holdings.coverageDepth, aRows: snapA?.rows.length ?? 0, bRows: snapB?.rows.length ?? 0 },
          basedOnAvailableDataOnly: true,
        });
        continue;
      }
      const bByKey = new Map(snapB.rows.map((r) => [r.key, r]));
      const shared: Array<{ name: string; weightA: number; weightB: number }> = [];
      let overlapWeight = 0;
      for (const rowA of snapA.rows) {
        const rowB = bByKey.get(rowA.key);
        if (rowB) { shared.push({ name: rowA.name, weightA: rowA.weightPct, weightB: rowB.weightPct }); overlapWeight += Math.min(rowA.weightPct, rowB.weightPct); }
      }
      shared.sort((x, y) => Math.min(y.weightA, y.weightB) - Math.min(x.weightA, x.weightB));
      overlaps.push({
        a: aRef, b: bRef, available: true, sharedCount: shared.length, overlapWeightPct: overlapWeight, topShared: shared.slice(0, 10),
        basis: { aDepth: a.holdings.coverageDepth, bDepth: b.holdings.coverageDepth, aRows: snapA.rows.length, bRows: snapB.rows.length },
        basedOnAvailableDataOnly: a.holdings.coverageDepth !== "FULL" || b.holdings.coverageDepth !== "FULL",
      });
    }
  }

  return { ok: true, count: items.length, items, overlaps };
}
