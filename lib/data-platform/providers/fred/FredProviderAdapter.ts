import type { ProviderAdapter, ProviderFetchRequest, ProviderPoint, ProviderValidation } from "../ProviderAdapter.ts";

type FredPayload = { observations?: Array<{ date: string; value: string; realtime_start?: string; realtime_end?: string }> };

/** Official FRED adapter for macro series and mapped US yield series. */
export class FredProviderAdapter implements ProviderAdapter {
  readonly id = "FRED";
  readonly supportedAssetClasses = ["MACRO", "BOND_YIELD"] as const;

  constructor(private readonly apiKey = process.env.FRED_API_KEY) {}

  source() { return { provider: "FRED", method: "FRED_SERIES_OBSERVATIONS_API" }; }

  async fetchLatest(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    return this.fetch(request, request.instrument.latestDate ?? new Date(Date.now() - 31 * 86_400_000));
  }

  async fetchHistorical(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    return this.fetch(request, request.startDate ?? new Date("1900-01-01T00:00:00.000Z"));
  }

  normalize(payload: unknown): ProviderPoint[] {
    return ((payload as FredPayload).observations ?? []).map((observation) => ({
      date: new Date(`${observation.date}T00:00:00.000Z`),
      value: observation.value === "." ? null : Number(observation.value),
    })).filter((point) => point.value !== null && Number.isFinite(point.value));
  }

  validate(points: ProviderPoint[]): ProviderValidation {
    return points.length && points.every((point) => point.value !== null && Number.isFinite(point.value))
      ? { valid: true }
      : { valid: false, reason: "FRED_NO_DATA" };
  }

  private async fetch(request: ProviderFetchRequest, start: Date): Promise<ProviderPoint[]> {
    if (!this.apiKey) throw new Error("FRED_API_KEY_REQUIRED");
    const url = new URL("https://api.stlouisfed.org/fred/series/observations");
    url.searchParams.set("series_id", request.instrument.symbol);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("file_type", "json");
    url.searchParams.set("sort_order", "asc");
    url.searchParams.set("observation_start", start.toISOString().slice(0, 10));
    if (request.endDate) url.searchParams.set("observation_end", request.endDate.toISOString().slice(0, 10));
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`FRED_HTTP_${response.status}`);
    const points = this.normalize(await response.json());
    const validation = this.validate(points);
    if (!validation.valid) throw new Error(validation.reason);
    return points;
  }
}
