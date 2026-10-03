// Nomura Asset Management Taiwan — official public PCF/holdings API. Verified 2026-09-24: no auth, no
// cookie, same endpoint works unmodified for every Nomura ETF, active or passive (only FundNo changes).
import type { CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.nomurafunds.com.tw";

type NomuraDateResponse = { Entries: { LatestDate: string | null; AllDate: string[] | null }; StatusCode: number };
type NomuraStock = { CStockCode: string; CStockName: string; CQuantity: number; CWeightsPct: number };
type NomuraFuture = { CFuturesCode: string; CFuturesName: string; CQuantity: number; CWeightsPct: number; CContractYm: string };
type NomuraBond = { CBondCode: string; CBondName: string; CBalParValue: number; CHoldRatio: number };
type NomuraEtf = { CStockCode: string; CStockName: string; CQuantity: number; CWeightsPct: number };
type NomuraTradeInfoResponse = {
  StatusCode: number;
  Entries: {
    CFundId: string;
    CPcfdate: string;
    CNavDtStr: string;
    CAnceTotalAv: number;
    CAnceTotalIssues: number;
    Stocks: NomuraStock[] | null;
    Futures: NomuraFuture[] | null;
    Bonds: NomuraBond[] | null;
    Etfs: NomuraEtf[] | null;
  };
};

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`NOMURA_HTTP_${r.status}`);
  return r.json();
}

export const NomuraOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "Nomura",

  async listAvailableDates(etfCode: string): Promise<string[]> {
    const j = await post<NomuraDateResponse>("/API/ETFAPI/api/Fund/GetFundTradeInfoDate", {
      Type: 1, Keyword: "", FundNo: etfCode, Date: "",
    });
    if (j.StatusCode !== 0 || !j.Entries.AllDate) throw new Error(`NOMURA_NO_DATES_${etfCode}`);
    return [...j.Entries.AllDate].reverse(); // newest first
  },

  async fetchSnapshot(etfCode: string, date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    let d = date;
    if (!d) {
      const dates = await post<NomuraDateResponse>("/API/ETFAPI/api/Fund/GetFundTradeInfoDate", {
        Type: 1, Keyword: "", FundNo: etfCode, Date: "",
      }, signal);
      d = dates.Entries.LatestDate ?? undefined;
      if (!d) throw new Error(`NOMURA_NO_LATEST_DATE_${etfCode}`);
    }
    const j = await post<NomuraTradeInfoResponse>("/API/ETFAPI/api/Fund/GetFundTradeInfo", {
      Type: 1, Keyword: "", FundNo: etfCode, Date: d,
    }, signal);
    if (j.StatusCode !== 0) throw new Error(`NOMURA_FETCH_FAILED_${etfCode}_${d}`);
    const e = j.Entries;
    const stocks = e.Stocks ?? [];
    const futures = e.Futures ?? [];
    const bonds = e.Bonds ?? [];
    const etfs = e.Etfs ?? [];
    if (!stocks.length && !futures.length && !bonds.length && !etfs.length) {
      throw new Error(`NOMURA_NO_HOLDINGS_${etfCode}_${d}`);
    }
    const outstandingUnits = e.CAnceTotalIssues;
    return {
      etfCode: e.CFundId,
      issuer: "Nomura",
      assetType:
        bonds.length && stocks.length ? "MULTI_ASSET" :
        bonds.length ? "BOND" :
        stocks.length ? "EQUITY" : "OTHER",
      dataDate: e.CNavDtStr.replaceAll("/", "-"),
      announcementDate: e.CPcfdate.slice(0, 10),
      fundNav: e.CAnceTotalAv,
      outstandingUnits,
      positions: [
        ...stocks.map((s) => ({
          securityCode: s.CStockCode,
          securityName: s.CStockName,
          positionType: "EQUITY" as const,
          positionAmount: s.CQuantity,
          positionUnit: "SHARES" as const,
          weight: s.CWeightsPct,
          canonicalSecurityId: null,
        })),
        ...bonds.map((b) => ({
          securityCode: b.CBondCode,
          securityName: b.CBondName,
          positionType: "BOND" as const,
          // Official par value is CBalParValue; CMarketValue (present on the row) is never used here.
          positionAmount: b.CBalParValue,
          positionUnit: "PAR_VALUE" as const,
          weight: b.CHoldRatio,
          canonicalSecurityId: null,
        })),
        ...futures.map((f) => ({
          securityCode: f.CFuturesCode,
          securityName: f.CFuturesName,
          positionType: "FUTURE" as const,
          positionAmount: f.CQuantity,
          positionUnit: "CONTRACTS" as const,
          weight: f.CWeightsPct,
          canonicalSecurityId: null,
        })),
        // Etfs[]: a holding of another listed ETF (quantity-based, its own security code) — not a common
        // stock, so kept as OTHER/OTHER rather than forced into EQUITY, per official-field-only semantics.
        ...etfs.map((x) => ({
          securityCode: x.CStockCode,
          securityName: x.CStockName,
          positionType: "OTHER" as const,
          positionAmount: x.CQuantity,
          positionUnit: "OTHER" as const,
          weight: x.CWeightsPct,
          canonicalSecurityId: null,
        })),
      ],
      source: "NOMURA_OFFICIAL_API",
      retrievedAt: new Date().toISOString(),
    };
  },
};
