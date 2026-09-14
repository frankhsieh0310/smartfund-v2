import { createHash } from "node:crypto";

export const COMPARE_PERIODS = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "MAX", "CUSTOM"] as const;
export const COMPARE_ASSET_TYPES = ["STOCK", "ETF", "FUND", "INDEX", "FX", "CRYPTO"] as const;
export const ALIGNMENT_POLICIES = ["EXACT_INTERSECTION", "PER_ITEM_AS_OF", "PREVIOUS_AVAILABLE_NO_FUTURE_FILL"] as const;
export const NORMALIZATION_POLICIES = ["NATIVE_NOT_NORMALIZED", "SAME_CURRENCY", "FX_NORMALIZED"] as const;

export type ComparePeriod = typeof COMPARE_PERIODS[number];
export type CompareAssetType = typeof COMPARE_ASSET_TYPES[number];
export type AlignmentPolicy = typeof ALIGNMENT_POLICIES[number];
export type NormalizationPolicy = typeof NORMALIZATION_POLICIES[number];
export type CompareRequestItem = { assetType: CompareAssetType; canonicalEntityId: string };
export type CompareContract = {
  items: CompareRequestItem[];
  period: ComparePeriod;
  startDate?: string | null;
  endDate?: string | null;
  requestedAsOfDate?: string | null;
  baseCurrency?: string | null;
  normalizationPolicy: NormalizationPolicy;
  alignmentPolicy: AlignmentPolicy;
};
export type Observation = { date: string; value: number; source: string | null; sourceRecordId?: string | null; updatedAt?: string | null };

const DAY = 86_400_000;
const PERIOD_DAYS: Partial<Record<ComparePeriod, number>> = { "1D": 1, "1W": 7, "1M": 31, "3M": 93, "6M": 186, "1Y": 366, "3Y": 1098, "5Y": 1830, "10Y": 3660 };

export function isoDay(value: Date | string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_DATE");
  return parsed.toISOString().slice(0, 10);
}

export function resolveWindow(contract: CompareContract, now = new Date()): { startDate: string | null; endDate: string } {
  const end = contract.endDate ?? contract.requestedAsOfDate ?? now.toISOString();
  const endDate = isoDay(end);
  if (contract.period === "CUSTOM") {
    if (!contract.startDate) throw new Error("CUSTOM_PERIOD_REQUIRES_START_DATE");
    const startDate = isoDay(contract.startDate);
    if (startDate > endDate) throw new Error("START_DATE_AFTER_END_DATE");
    return { startDate, endDate };
  }
  if (contract.period === "MAX") return { startDate: null, endDate };
  if (contract.period === "YTD") return { startDate: `${endDate.slice(0, 4)}-01-01`, endDate };
  const days = PERIOD_DAYS[contract.period];
  if (!days) throw new Error("UNSUPPORTED_PERIOD");
  return { startDate: new Date(Date.parse(`${endDate}T00:00:00.000Z`) - days * DAY).toISOString().slice(0, 10), endDate };
}

export function normalizeObservations(points: Observation[], startDate: string | null, endDate: string): Observation[] {
  const unique = new Map<string, Observation>();
  for (const point of points) {
    const day = isoDay(point.date);
    if (day > endDate || (startDate && day < startDate) || !Number.isFinite(point.value) || point.value <= 0) continue;
    unique.set(day, { ...point, date: day });
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function returnsByDate(points: Observation[]): Map<string, number> {
  const output = new Map<string, number>();
  for (let index = 1; index < points.length; index++) {
    const value = points[index].value / points[index - 1].value - 1;
    if (Number.isFinite(value)) output.set(points[index].date, value);
  }
  return output;
}

export function exactReturnIntersection(left: Observation[], right: Observation[]): Array<{ date: string; left: number; right: number }> {
  const l = returnsByDate(left);
  const r = returnsByDate(right);
  return [...l.entries()].flatMap(([date, value]) => r.has(date) ? [{ date, left: value, right: r.get(date)! }] : []);
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function seriesMetrics(points: Observation[], annualizationFactor: number) {
  if (points.length < 2) return { status: "INSUFFICIENT_HISTORY" as const, sampleCount: 0, cumulativeReturn: null, annualizedReturn: null, volatility: null, sharpe: null, maxDrawdown: null, drawdown: null, normalizedGrowth: [] };
  const returns = [...returnsByDate(points).values()];
  const average = mean(returns);
  const variance = returns.length > 1 ? returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1) : 0;
  const volatility = returns.length > 1 ? Math.sqrt(variance) * Math.sqrt(annualizationFactor) : null;
  const cumulativeReturn = points.at(-1)!.value / points[0].value - 1;
  const elapsedDays = Math.max(1, (Date.parse(points.at(-1)!.date) - Date.parse(points[0].date)) / DAY);
  const annualizedReturn = elapsedDays >= 365 ? (1 + cumulativeReturn) ** (365 / elapsedDays) - 1 : null;
  let peak = points[0];
  let trough = points[0];
  let worst = 0;
  let worstPeak = peak;
  let recoveryDate: string | null = null;
  for (const point of points) {
    if (point.value > peak.value) peak = point;
    const drawdown = point.value / peak.value - 1;
    if (drawdown < worst) { worst = drawdown; worstPeak = peak; trough = point; recoveryDate = null; }
    if (worst < 0 && point.date > trough.date && point.value >= worstPeak.value && recoveryDate === null) recoveryDate = point.date;
  }
  return {
    status: "READY" as const,
    sampleCount: returns.length,
    cumulativeReturn,
    annualizedReturn,
    volatility,
    sharpe: null,
    maxDrawdown: worst,
    drawdown: { peakDate: worstPeak.date, troughDate: trough.date, recoveryDate },
    normalizedGrowth: points.map((point) => ({ date: point.date, value: point.value / points[0].value * 100 })),
  };
}

export function correlation(left: Observation[], right: Observation[], minimumSample = 20) {
  const paired = exactReturnIntersection(left, right);
  if (paired.length < minimumSample) return { status: "INSUFFICIENT_OVERLAP" as const, value: null, sampleCount: paired.length, startDate: paired[0]?.date ?? null, endDate: paired.at(-1)?.date ?? null };
  const leftMean = mean(paired.map((point) => point.left));
  const rightMean = mean(paired.map((point) => point.right));
  const numerator = paired.reduce((sum, point) => sum + (point.left - leftMean) * (point.right - rightMean), 0);
  const denominator = Math.sqrt(paired.reduce((sum, point) => sum + (point.left - leftMean) ** 2, 0) * paired.reduce((sum, point) => sum + (point.right - rightMean) ** 2, 0));
  return { status: denominator ? "READY" as const : "INSUFFICIENT_VARIANCE" as const, value: denominator ? numerator / denominator : null, sampleCount: paired.length, startDate: paired[0].date, endDate: paired.at(-1)!.date };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function requestHash(contract: CompareContract, watermarks: Record<string, string | null>, metricVersion: string): string {
  const canonical = { ...contract, items: [...contract.items].sort((a, b) => `${a.assetType}:${a.canonicalEntityId}`.localeCompare(`${b.assetType}:${b.canonicalEntityId}`)), upstreamWatermarks: watermarks, metricVersion };
  return createHash("sha256").update(stable(canonical)).digest("hex");
}
