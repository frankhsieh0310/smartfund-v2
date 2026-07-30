export type ProviderAssetClass =
  | "STOCK"
  | "ETF"
  | "MACRO"
  | "BOND_YIELD"
  | "MARKET_INDEX"
  | "VOLATILITY"
  | "COMMODITY"
  | "FX"
  | "CRYPTO";

export type ProviderInstrument = {
  id: string;
  symbol: string;
  latestDate?: Date | null;
  metadata?: Record<string, string | number | boolean | null>;
};

export type ProviderPoint = {
  date: Date;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  adjustedClose?: number | null;
  volume?: number | null;
  value?: number | null;
};

export type ProviderFetchRequest = {
  assetClass: ProviderAssetClass;
  instrument: ProviderInstrument;
  startDate?: Date;
  endDate?: Date;
};

export type ProviderValidation = { valid: boolean; reason?: string };

/**
 * Every data source is a plugin.  Lifecycle coordinators may dispatch this
 * interface, but may not embed provider URLs, parsing, or source attribution.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly supportedAssetClasses: readonly ProviderAssetClass[];
  fetchLatest(request: ProviderFetchRequest): Promise<ProviderPoint[]>;
  /**
   * The newest dated observation the provider currently publishes for this
   * instrument. This deliberately represents provider availability, not the
   * local calendar, so markets with different sessions and official series
   * with publication lags are not falsely marked stale.
   */
  latestAvailableDate(request: ProviderFetchRequest): Promise<Date | null>;
  fetchHistorical(request: ProviderFetchRequest): Promise<ProviderPoint[]>;
  normalize(payload: unknown): ProviderPoint[];
  validate(points: ProviderPoint[]): ProviderValidation;
  source(): { provider: string; method: string };
}
