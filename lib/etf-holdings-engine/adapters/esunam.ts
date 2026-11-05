// E.Sun (玉山) Securities Investment Trust — official ETF holdings JSON API, plain HTTP POST, no
// headless browser, no cookie, no UA spoofing.
// VERIFIED 2026-11-05: each fund's official product page (https://www.esunam.com/ETF/etf-info/<id>
// ?tab=4, the "持股比重" tab) calls the site's own JSON endpoint
// POST https://www.esunam.com/ETFAPI/GetFundAssets  body {"FundID": "<id>"}
// — captured live via network-request inspection, replayed directly and confirmed to need no cookie/
// session/auth. Response carries a `Table[]` array: one entry titled "" (asset-category summary), one
// titled "股票" (equity rows: code/name/shares/weight%) or "債券" (bond rows: ISIN/name/par/weight%,
// whichever the fund actually holds), and one titled "期貨" or "持債特性" (ignored — not individual
// positions). fundId was harvested one-time from the official ETF總覽 page's own per-fund card links
// (https://www.esunam.com/ETF/etf-list, each card expands to /ETF/etf-info/<id>), never guessed.
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.esunam.com/ETFAPI/GetFundAssets";

// market ticker -> official internal FundID. One-time harvest 2026-11-05 from the official ETF總覽
// page's own per-fund card links (https://www.esunam.com/ETF/etf-list) — never guessed.
export const FUND_ID_MAP: Record<string, string> = {
  "009803": "50", "009810": "51", "009827": "53", "00988B": "52",
};

function num(s: string | number | undefined | null): number {
  if (s === undefined || s === null) return 0;
  if (typeof s === "number") return s;
  return Number(s.replace(/[^0-9.-]/g, "")) || 0;
}

type EsunamTable = { TableTitle: string; Rows: string[][] };
type EsunamResponse = {
  StatusCode: number;
  Entries: {
    FundID: string;
    Data: {
      FundAsset: { Aum: string; Units: string; Nav: string; NavDate: string };
      Table: EsunamTable[];
    };
  };
};

/** NavDate arrives as "YYYY/MM/DD" (Taipei calendar date, the site's own display format) — just
 * normalizes the separator, never recomputed from a timestamp. */
function normalizeDate(navDate: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(navDate);
  if (!m) throw new Error(`ESUNAM_UNPARSEABLE_DATE_${navDate}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export const EsunamOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "ESUNAM",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const fundId = FUND_ID_MAP[etfCode];
    if (!fundId) throw new Error(`ESUNAM_UNMAPPED_ETF_${etfCode} — not in the official FundID map, never guessed`);

    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ FundID: fundId }),
      signal,
    });
    if (!res.ok) throw new Error(`ESUNAM_HTTP_${res.status}`);
    const json = (await res.json()) as EsunamResponse;
    if (json.StatusCode !== 0 || json.Entries?.FundID !== fundId) throw new Error(`ESUNAM_BAD_RESPONSE_${etfCode}`);

    const tables = json.Entries.Data.Table ?? [];
    const stockTable = tables.find((t) => t.TableTitle === "股票");
    const bondTable = tables.find((t) => t.TableTitle === "債券");
    const isBondFund = (bondTable?.Rows?.length ?? 0) > 0;

    const positions: CanonicalPosition[] = isBondFund
      ? (bondTable?.Rows ?? []).map((r) => ({
          securityCode: r[0],
          securityName: r[1],
          positionType: "BOND" as const,
          positionAmount: num(r[2]),
          positionUnit: "PAR_VALUE" as const,
          weight: num(r[3]),
          canonicalSecurityId: null,
        }))
      : (stockTable?.Rows ?? []).map((r) => ({
          securityCode: r[0],
          securityName: r[1],
          positionType: "EQUITY" as const,
          positionAmount: num(r[2]),
          positionUnit: "SHARES" as const,
          weight: num(r[3]),
          canonicalSecurityId: null,
        }));
    if (!positions.length) throw new Error(`ESUNAM_NO_HOLDINGS_${etfCode}`);

    const dataDate = normalizeDate(json.Entries.Data.FundAsset.NavDate);
    return {
      etfCode,
      issuer: "ESUNAM",
      assetType: isBondFund ? "BOND" : "EQUITY",
      dataDate,
      announcementDate: dataDate,
      fundNav: num(json.Entries.Data.FundAsset.Nav),
      outstandingUnits: num(json.Entries.Data.FundAsset.Units),
      positions,
      source: "ESUNAM_OFFICIAL_FUND_ASSETS_API",
      retrievedAt: new Date().toISOString(),
    };
  },
};
