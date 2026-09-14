import type { ProviderAdapter, ProviderFetchRequest, ProviderPoint, ProviderValidation } from "../ProviderAdapter.ts";

type DbnomicsSeries = { period?: string[]; value?: Array<number | null> };
type DbnomicsPayload = { series?: { docs?: DbnomicsSeries[] }; dataset?: { series?: { docs?: DbnomicsSeries[] } } };

/** Public DBnomics backup adapter. Symbols are provider/dataset/series and require a verified canonical mapping. */
export class DbnomicsProviderAdapter implements ProviderAdapter {
  readonly id = "DBnomics";
  readonly supportedAssetClasses = ["MACRO"] as const;
  private readonly cache = new Map<string, Promise<ProviderPoint[]>>();

  source() { return { provider: "DBnomics", method: "DBNOMICS_V22_PUBLIC_BACKUP" }; }
  fetchLatest(request: ProviderFetchRequest) { return this.fetch(request); }
  fetchHistorical(request: ProviderFetchRequest) { return this.fetch(request); }
  async latestAvailableDate(request: ProviderFetchRequest) { return (await this.fetch(request)).at(-1)?.date ?? null; }

  normalize(payload: unknown): ProviderPoint[] {
    const body = payload as DbnomicsPayload;
    const series = body.series?.docs?.[0] ?? body.dataset?.series?.docs?.[0];
    const periods = series?.period ?? [], values = series?.value ?? [];
    return periods.map((period, index) => ({ date: this.periodDate(period), value: values[index] }))
      .filter((point): point is ProviderPoint & { value: number } => !Number.isNaN(point.date.getTime()) && point.value !== null && Number.isFinite(point.value))
      .sort((left, right) => left.date.getTime() - right.date.getTime());
  }

  validate(points: ProviderPoint[]): ProviderValidation { return points.length ? { valid: true } : { valid: false, reason: "DBNOMICS_NO_DATA" }; }

  private periodDate(period: string): Date {
    if (/^\d{4}$/.test(period)) return new Date(`${period}-01-01T00:00:00.000Z`);
    const quarter = period.match(/^(\d{4})-Q([1-4])$/); if (quarter) return new Date(`${quarter[1]}-${String((Number(quarter[2])-1)*3+1).padStart(2,"0")}-01T00:00:00.000Z`);
    const month = period.match(/^(\d{4})-(\d{2})$/); if (month) return new Date(`${period}-01T00:00:00.000Z`);
    return new Date(period);
  }

  private fetch(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    if (!request.instrument.metadata?.canonicalMappingVerified) return Promise.reject(new Error(`DBNOMICS_CANONICAL_MAPPING_REQUIRED:${request.instrument.symbol}`));
    if (request.instrument.symbol.split("/").length < 3) return Promise.reject(new Error(`DBNOMICS_INVALID_SERIES_ID:${request.instrument.symbol}`));
    const cached = this.cache.get(request.instrument.symbol); if (cached) return cached;
    const pending = (async () => {
      const url = new URL(`https://api.db.nomics.world/v22/series/${request.instrument.symbol}`); url.searchParams.set("observations", "1");
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`DBNOMICS_HTTP_${response.status}`);
      const points = this.normalize(await response.json())
        .filter(point => !request.startDate || point.date >= request.startDate)
        .filter(point => !request.endDate || point.date <= request.endDate);
      const validation = this.validate(points); if (!validation.valid) throw new Error(validation.reason); return points;
    })();
    this.cache.set(request.instrument.symbol, pending); return pending;
  }
}
