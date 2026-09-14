import type { ProviderAdapter, ProviderFetchRequest, ProviderPoint, ProviderValidation } from "../ProviderAdapter.ts";

type WorldBankRow = { date?: string; value?: number | null };

/** Official World Bank Indicators API adapter. Symbols use INDICATOR:country. */
export class WorldBankProviderAdapter implements ProviderAdapter {
  readonly id = "World Bank";
  readonly supportedAssetClasses = ["MACRO"] as const;
  private readonly cache = new Map<string, Promise<ProviderPoint[]>>();

  source() { return { provider: "World Bank", method: "WORLD_BANK_INDICATORS_V2" }; }
  fetchLatest(request: ProviderFetchRequest) { return this.fetch(request); }
  async latestAvailableDate(request: ProviderFetchRequest) { return (await this.fetch(request)).at(-1)?.date ?? null; }
  fetchHistorical(request: ProviderFetchRequest) { return this.fetch(request); }
  normalize(payload: unknown): ProviderPoint[] {
    const rows = (Array.isArray(payload) ? payload[1] : []) as WorldBankRow[] | undefined;
    return (rows ?? []).filter((row) => /^\d{4}$/.test(row.date ?? "") && row.value !== null && Number.isFinite(row.value))
      .map((row) => ({ date: new Date(`${row.date}-01-01T00:00:00.000Z`), value: row.value! }))
      .sort((left, right) => left.date.getTime() - right.date.getTime());
  }
  validate(points: ProviderPoint[]): ProviderValidation { return points.length ? { valid: true } : { valid: false, reason: "WORLD_BANK_NO_DATA" }; }

  private fetch(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    const separator = request.instrument.symbol.lastIndexOf(":");
    const indicator = request.instrument.symbol.slice(0, separator);
    const country = request.instrument.symbol.slice(separator + 1);
    if (separator < 1 || !country) return Promise.reject(new Error(`WORLD_BANK_INVALID_SERIES_ID:${request.instrument.symbol}`));
    const cached = this.cache.get(request.instrument.symbol);
    if (cached) return cached;
    const pending = (async () => {
      const url = new URL(`https://api.worldbank.org/v2/country/${country}/indicator/${indicator}`);
      url.searchParams.set("format", "json"); url.searchParams.set("per_page", "100");
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`WORLD_BANK_HTTP_${response.status}`);
      const points = this.normalize(await response.json()).filter((point) => !request.startDate || point.date >= request.startDate).filter((point) => !request.endDate || point.date <= request.endDate);
      const validation = this.validate(points);
      if (!validation.valid) throw new Error(validation.reason);
      return points;
    })();
    this.cache.set(request.instrument.symbol, pending);
    return pending;
  }
}
