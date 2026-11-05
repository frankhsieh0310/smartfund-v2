// Franklin Templeton Taiwan (富蘭克林華美) Securities Investment Trust — official ETF holdings JSON
// API, plain HTTP GET, no headless browser, no cookie, no UA spoofing.
// VERIFIED 2026-11-05: each fund's official product page (https://www.ftft.com.tw/etf/product/
// details?id=<fundId>) has a "持股權重" tab that, once opened, calls the site's own JSON endpoint
// https://www.ftft.com.tw/official/api/etf/shares/<fundId>?date=<YYYYMMDD|blank-for-latest> — captured
// live via network-request inspection, never guessed. fundId was harvested one-time from the official
// ETF overview page's own NAV-tile links (/etf/product/details?id=X), not guessed.
// Equity funds return their positions in `Secs[]`; bond funds (asset category "債券") return `Bonds[]`
// instead, carrying the bond's own ISIN as BondCode and full description as BondName, with
// WeightingPercentage as the official percentage string — copied verbatim, never recomputed.
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.ftft.com.tw/official/api/etf/shares";

// market ticker -> official internal FundID. One-time harvest 2026-11-05 from the official ETF overview
// page's own NAV-tile links (https://www.ftft.com.tw/etf/, each tile links to
// /etf/product/details?id=<FundID>) — never guessed.
export const FUND_ID_MAP: Record<string, string> = {
  "00899": "130", "00905": "131", "00961": "162", "009831": "191",
  "00982B": "173", "00986B": "176",
};

function num(s: string | number | undefined | null): number {
  if (s === undefined || s === null) return 0;
  if (typeof s === "number") return s;
  return Number(s.replace(/[^0-9.-]/g, "")) || 0;
}

function pct(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace("%", "")) || 0;
}

type FtftSec = { SecuritiesCode: string; SecuritiesName: string; Shares: number; WeightingPercentage: string };
type FtftBond = { BondCode: string; BondName: string; ParValue: number; WeightingPercentage: string };
type FtftResponse = {
  StockCode: string;
  AssetDate: string;
  NetAssetValuePerUnit: number;
  TotalUnitsOutstanding: number;
  Secs: FtftSec[];
  Bonds: FtftBond[];
};

/** AssetDate arrives as an ISO instant at the previous Taipei midnight (e.g. "2026-11-03T16:00:00Z" for
 * 2026-11-04 Taipei) — adding 8h and taking the date slice reproduces the Taipei calendar date exactly,
 * same technique already used by this engine's other adapters for similar UTC-midnight-offset sources. */
function toTaipeiDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export const FtftOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "FTFT",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const fundId = FUND_ID_MAP[etfCode];
    if (!fundId) throw new Error(`FTFT_UNMAPPED_ETF_${etfCode} — not in the official FundID map, never guessed`);

    const res = await fetch(`${BASE}/${fundId}?date=`, { signal });
    if (!res.ok) throw new Error(`FTFT_HTTP_${res.status}`);
    const json = (await res.json()) as FtftResponse;
    if (json.StockCode !== etfCode) throw new Error(`FTFT_STOCKCODE_MISMATCH_expected_${etfCode}_got_${json.StockCode}`);

    const isBondFund = (json.Bonds?.length ?? 0) > 0;
    const positions: CanonicalPosition[] = isBondFund
      ? (json.Bonds ?? []).map((b) => ({
          securityCode: b.BondCode,
          securityName: b.BondName,
          positionType: "BOND" as const,
          positionAmount: num(b.ParValue),
          positionUnit: "PAR_VALUE" as const,
          weight: pct(b.WeightingPercentage),
          canonicalSecurityId: null,
        }))
      : (json.Secs ?? []).map((s) => ({
          securityCode: s.SecuritiesCode,
          securityName: s.SecuritiesName,
          positionType: "EQUITY" as const,
          positionAmount: num(s.Shares),
          positionUnit: "SHARES" as const,
          weight: pct(s.WeightingPercentage),
          canonicalSecurityId: null,
        }));
    if (!positions.length) throw new Error(`FTFT_NO_HOLDINGS_${etfCode}`);

    const dataDate = toTaipeiDate(json.AssetDate);
    return {
      etfCode,
      issuer: "FTFT",
      assetType: isBondFund ? "BOND" : "EQUITY",
      dataDate,
      announcementDate: dataDate,
      fundNav: num(json.NetAssetValuePerUnit),
      outstandingUnits: num(json.TotalUnitsOutstanding),
      positions,
      source: "FTFT_OFFICIAL_SHARES_API",
      retrievedAt: new Date().toISOString(),
    };
  },
};
