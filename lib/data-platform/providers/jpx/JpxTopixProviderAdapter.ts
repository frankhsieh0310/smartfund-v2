import type { ProviderAdapter, ProviderFetchRequest, ProviderPoint, ProviderValidation } from "../ProviderAdapter.ts";

type JpxTopixPayload = {
  MainStockIndex?: {
    Topix?: {
      openingPrice?: string;
      highPrice?: string;
      lowPrice?: string;
      currentPrice?: string;
    };
  };
  publishedAt?: string;
};

const VALUES_URL = "https://www.jpx.co.jp/market/indices/e_indices_stock_price3.txt";
const TIME_URL = "https://www.jpx.co.jp/market/indices/e_indices_stock_price3.time.txt";

/** Official JPX public latest-value adapter for TOPIX. */
export class JpxTopixProviderAdapter implements ProviderAdapter {
  readonly id = "JPX_TOPIX";
  readonly supportedAssetClasses = ["MARKET_INDEX"] as const;

  source() { return { provider: "JPX", method: "JPX_PUBLIC_INDEX_JSON" }; }

  async fetchLatest(_request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    const [valuesResponse, timeResponse] = await Promise.all([
      fetch(VALUES_URL, { signal: AbortSignal.timeout(30_000) }),
      fetch(TIME_URL, { signal: AbortSignal.timeout(30_000) }),
    ]);
    if (!valuesResponse.ok) throw new Error(`JPX_TOPIX_HTTP_${valuesResponse.status}`);
    if (!timeResponse.ok) throw new Error(`JPX_TOPIX_TIME_HTTP_${timeResponse.status}`);
    const payload = await valuesResponse.json() as JpxTopixPayload;
    payload.publishedAt = (await timeResponse.text()).trim();
    const points = this.normalize(payload);
    const validation = this.validate(points);
    if (!validation.valid) throw new Error(validation.reason);
    return points;
  }

  async latestAvailableDate(request: ProviderFetchRequest): Promise<Date | null> {
    return (await this.fetchLatest(request)).at(-1)?.date ?? null;
  }

  async fetchHistorical(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    // Latest-first recovery intentionally avoids replaying JPX history.
    return this.fetchLatest(request);
  }

  normalize(payload: unknown): ProviderPoint[] {
    const value = payload as JpxTopixPayload;
    const topix = value.MainStockIndex?.Topix;
    const stamp = value.publishedAt;
    if (!topix || !stamp || !/^\d{12}$/.test(stamp)) return [];
    const number = (raw?: string): number | null => {
      const parsed = Number(raw?.replaceAll(",", ""));
      return Number.isFinite(parsed) ? parsed : null;
    };
    return [{
      date: new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00.000Z`),
      open: number(topix.openingPrice),
      high: number(topix.highPrice),
      low: number(topix.lowPrice),
      close: number(topix.currentPrice),
      volume: null,
    }];
  }

  validate(points: ProviderPoint[]): ProviderValidation {
    const point = points[0];
    if (!point || point.close == null) return { valid: false, reason: "JPX_TOPIX_NO_DATA" };
    if (point.high != null && point.low != null && point.high < point.low) return { valid: false, reason: "JPX_TOPIX_INVALID_OHLC" };
    return { valid: true };
  }
}
