import type { ProviderAdapter, ProviderFetchRequest, ProviderPoint, ProviderValidation } from "../ProviderAdapter.ts";

type DataMapperPayload = { values?: Record<string, Record<string, Record<string, number | null>>> };

/** Official IMF DataMapper adapter. Series symbols use INDICATOR:ISO3. */
export class ImfProviderAdapter implements ProviderAdapter {
  readonly id = "IMF";
  readonly supportedAssetClasses = ["MACRO"] as const;
  private readonly cache = new Map<string, Promise<DataMapperPayload>>();

  source() { return { provider: "IMF", method: "IMF_DATAMAPPER_V2" }; }
  fetchLatest(request: ProviderFetchRequest) { return this.fetch(request); }
  async latestAvailableDate(request: ProviderFetchRequest) { return (await this.fetch(request)).at(-1)?.date ?? null; }
  fetchHistorical(request: ProviderFetchRequest) { return this.fetch(request); }

  normalize(payload: unknown): ProviderPoint[] {
    const { indicator, country, body } = payload as { indicator: string; country: string; body: DataMapperPayload };
    const values = body.values?.[indicator]?.[country] ?? {};
    return Object.entries(values)
      .filter(([period, value]) => /^\d{4}$/.test(period) && value !== null && Number.isFinite(value))
      .map(([period, value]) => ({ date: new Date(`${period}-01-01T00:00:00.000Z`), value }))
      .filter((point) => point.date.getTime() <= Date.now() + 86_400_000)
      .sort((left, right) => left.date.getTime() - right.date.getTime());
  }

  validate(points: ProviderPoint[]): ProviderValidation { return points.length ? { valid: true } : { valid: false, reason: "IMF_NO_DATA" }; }

  private fetch(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    const [indicator, country] = request.instrument.symbol.split(":");
    if (!indicator || !country) return Promise.reject(new Error(`IMF_INVALID_SERIES_ID:${request.instrument.symbol}`));
    let pending = this.cache.get(indicator);
    if (!pending) {
      pending = (async () => {
      const response = await fetch(`https://www.imf.org/external/datamapper/api/v2/${indicator}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`IMF_HTTP_${response.status}`);
      return response.json() as Promise<DataMapperPayload>;
      })();
      this.cache.set(indicator, pending);
    }
    return pending.then((body) => {
      const points = this.normalize({ indicator, country, body });
      const validation = this.validate(points);
      if (!validation.valid) throw new Error(validation.reason);
      return points.filter((point) => !request.startDate || point.date >= request.startDate).filter((point) => !request.endDate || point.date <= request.endDate);
    });
  }
}
