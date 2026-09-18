// Pure concentration analysis. No DB, no UI — takes one product's holdings rows in, returns
// concentration metrics out. Reuses HoldingRow's shape but allows the optional sector/country
// metadata the concentration breakdown needs (both already exist on etf_holding_rows and the
// fund-side holdings table — no schema change).

export type HoldingRowWithMeta = {
  key: string;
  name: string;
  weightPct: number;
  sector?: string | null;
  country?: string | null;
};

export type ConcentrationBucket = { label: string; weightPct: number };

export type ConcentrationResult = {
  top10Pct: number;
  top20Pct: number;
  largestHolding: { key: string; name: string; weightPct: number } | null;
  sectorConcentration: ConcentrationBucket[]; // sorted desc, unlabeled sector rolled into "Unclassified"
  countryConcentration: ConcentrationBucket[];
};

function sumTopN(sortedDesc: HoldingRowWithMeta[], n: number): number {
  return Math.round(sortedDesc.slice(0, n).reduce((s, h) => s + h.weightPct, 0) * 100) / 100;
}

function bucketBy(rows: HoldingRowWithMeta[], field: "sector" | "country"): ConcentrationBucket[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const label = row[field]?.trim() || "Unclassified";
    totals.set(label, (totals.get(label) ?? 0) + row.weightPct);
  }
  return [...totals.entries()]
    .map(([label, weightPct]) => ({ label, weightPct: Math.round(weightPct * 100) / 100 }))
    .sort((a, b) => b.weightPct - a.weightPct);
}

export function computeConcentration(holdings: HoldingRowWithMeta[]): ConcentrationResult {
  const sorted = [...holdings].sort((a, b) => b.weightPct - a.weightPct);
  const largest = sorted[0] ?? null;
  return {
    top10Pct: sumTopN(sorted, 10),
    top20Pct: sumTopN(sorted, 20),
    largestHolding: largest ? { key: largest.key, name: largest.name, weightPct: largest.weightPct } : null,
    sectorConcentration: bucketBy(holdings, "sector"),
    countryConcentration: bucketBy(holdings, "country"),
  };
}
