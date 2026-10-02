// Canonical daily-holdings model for Taiwan ETFs (active + passive), sourced only from each issuer's own
// official public PCF/holdings source (API, server-rendered HTML, or official page automation — never
// third-party, never scraped from an aggregator, never guessed). One shape, every issuer, every asset type.

export type PositionType = "EQUITY" | "BOND" | "FUTURE" | "OPTION" | "OTHER";
export type PositionUnit = "SHARES" | "PAR_VALUE" | "CONTRACTS" | "OTHER";

export type CanonicalPosition = {
  securityCode: string;
  securityName: string;
  positionType: PositionType;
  /**
   * The position's amount in its OWN official unit — never coerced across asset types:
   *  - EQUITY -> share count
   *  - BOND   -> official par/nominal value (never converted to lots/shares)
   *  - FUTURE -> contract count
   *  - OPTION -> contract count
   * A single ETF's positions array may legitimately mix units (e.g. a multi-asset fund holding both
   * equities and futures) — that is why positionUnit travels alongside every row instead of living once
   * on the snapshot.
   */
  positionAmount: number;
  positionUnit: PositionUnit;
  weight: number;
  /** Filled only when an exact, verified mapping to the canonical security-master ID exists. Never guessed. */
  canonicalSecurityId: string | null;
};

export type FundAssetType = "EQUITY" | "BOND" | "MULTI_ASSET" | "OTHER";

export type CanonicalSnapshot = {
  etfCode: string;
  issuer: string;
  /** Fund-level classification, independent of any one position's type (a fund can hold futures/cash
   * alongside its primary asset class without changing this). */
  assetType: FundAssetType;
  /** The date the holdings actually reflect (YYYY-MM-DD). */
  dataDate: string;
  /** The date the issuer announced/published this snapshot (YYYY-MM-DD). */
  announcementDate: string;
  fundNav: number;
  outstandingUnits: number;
  positions: CanonicalPosition[];
  source: string;
  retrievedAt: string;
};

export interface OfficialPcfAdapter {
  readonly issuer: string;
  /** Official response for the latest (or an explicit) date, normalized to CanonicalSnapshot. Throws if
   * the issuer has no data for that date/ETF rather than returning a partial/guessed snapshot. */
  fetchSnapshot(etfCode: string, date?: string): Promise<CanonicalSnapshot>;
  /** Available data dates for this ETF, newest first, straight from the issuer's own date-list API.
   * Optional — many issuers only expose "latest" or a fixed-date query, never fabricate a range for those. */
  listAvailableDates?(etfCode: string): Promise<string[]>;
}
