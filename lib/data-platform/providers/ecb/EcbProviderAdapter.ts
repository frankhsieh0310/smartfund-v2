import type { ProviderAdapter, ProviderFetchRequest, ProviderPoint, ProviderValidation } from "../ProviderAdapter.ts";

/** Official ECB SDW adapter for ECB macro and rate series. */
export class EcbProviderAdapter implements ProviderAdapter {
  readonly id = "ECB";
  readonly supportedAssetClasses = ["MACRO", "BOND_YIELD"] as const;

  source() { return { provider: "ECB", method: "ECB_DATA_API_CSV" }; }

  async fetchLatest(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    return this.fetch(request, request.instrument.latestDate ?? new Date(Date.now() - 31 * 86_400_000));
  }

  async latestAvailableDate(request: ProviderFetchRequest): Promise<Date | null> {
    const points = await this.fetch(request, undefined, true);
    return points.at(-1)?.date ?? null;
  }

  async fetchHistorical(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    return this.fetch(request, request.startDate ?? new Date("1900-01-01T00:00:00.000Z"));
  }

  normalize(payload: unknown): ProviderPoint[] {
    const lines = String(payload).trim().split(/\r?\n/).filter(Boolean);
    const headers = lines.shift()?.split(",").map((header) => header.replace(/^"|"$/g, "")) ?? [];
    const periodIndex = headers.indexOf("TIME_PERIOD");
    const valueIndex = headers.indexOf("OBS_VALUE");
    if (periodIndex < 0 || valueIndex < 0) return [];
    return lines.map((line) => line.split(",").map((value) => value.replace(/^"|"$/g, ""))).map((columns) => ({
      date: new Date(`${columns[periodIndex]}T00:00:00.000Z`), value: Number(columns[valueIndex]),
    })).filter((point) => !Number.isNaN(point.date.getTime()) && Number.isFinite(point.value));
  }

  validate(points: ProviderPoint[]): ProviderValidation {
    return points.length && points.every((point) => point.value !== null && Number.isFinite(point.value))
      ? { valid: true }
      : { valid: false, reason: "ECB_NO_DATA" };
  }

  private async fetch(request: ProviderFetchRequest, start?: Date, latestOnly = false): Promise<ProviderPoint[]> {
    const url = new URL(`https://data-api.ecb.europa.eu/service/data/${request.instrument.symbol}`);
    url.searchParams.set("format", "csvdata");
    if (latestOnly) url.searchParams.set("lastNObservations", "1");
    if (start) url.searchParams.set("startPeriod", start.toISOString().slice(0, 10));
    if (request.endDate) url.searchParams.set("endPeriod", request.endDate.toISOString().slice(0, 10));
    const response = await fetch(url, { headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`ECB_HTTP_${response.status}`);
    const points = this.normalize(await response.text());
    const validation = this.validate(points);
    if (!validation.valid) throw new Error(validation.reason);
    return points;
  }
}
