import type { ProviderAdapter, ProviderFetchRequest, ProviderPoint, ProviderValidation } from "../ProviderAdapter.ts";

type YahooPayload = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<Record<string, Array<number | null>>>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }>;
  };
};

/** Yahoo Chart API adapter for market-priced assets. */
export class YahooChartProviderAdapter implements ProviderAdapter {
  readonly id = "YAHOO_CHART";
  readonly supportedAssetClasses = ["STOCK", "ETF", "MARKET_INDEX", "BOND_YIELD", "VOLATILITY", "COMMODITY", "FX", "CRYPTO"] as const;

  source() { return { provider: "YAHOO", method: "YAHOO_CHART_API" }; }

  async fetchLatest(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    return this.fetch(request, request.instrument.latestDate ?? new Date(Date.now() - 7 * 86_400_000));
  }

  async fetchHistorical(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    return this.fetch(request, request.startDate ?? new Date(0));
  }

  normalize(payload: unknown): ProviderPoint[] {
    const result = (payload as YahooPayload).chart?.result?.[0];
    if (!result) return [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];
    return (result.timestamp ?? []).map((timestamp, index) => ({
      date: new Date(timestamp * 1000),
      open: quote.open?.[index] ?? null,
      high: quote.high?.[index] ?? null,
      low: quote.low?.[index] ?? null,
      close: quote.close?.[index] ?? null,
      adjustedClose: adjusted[index] ?? null,
      volume: quote.volume?.[index] ?? null,
    })).filter((point) => point.close !== null);
  }

  validate(points: ProviderPoint[]): ProviderValidation {
    if (!points.length) return { valid: false, reason: "YAHOO_NO_DATA" };
    const invalid = points.find((point) => point.close === null
      || (point.high !== null && point.low !== null && point.high < point.low)
      || (point.high !== null && point.open !== null && point.high < point.open)
      || (point.low !== null && point.open !== null && point.low > point.open));
    return invalid ? { valid: false, reason: "INVALID_OHLCV" } : { valid: true };
  }

  private async fetch(request: ProviderFetchRequest, start: Date): Promise<ProviderPoint[]> {
    const period1 = Math.floor(start.getTime() / 1000);
    const period2 = Math.floor((request.endDate?.getTime() ?? Date.now() + 86_400_000) / 1000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(request.instrument.symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`, {
        headers: { "User-Agent": "Mozilla/5.0 (SmartFund Provider Adapter)" }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`YAHOO_HTTP_${response.status}`);
      const points = this.normalize(await response.json());
      const validation = this.validate(points);
      if (!validation.valid) throw new Error(validation.reason);
      return points;
    } finally { clearTimeout(timeout); }
  }
}
