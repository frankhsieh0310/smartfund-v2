// First Financial (第一金) Securities Investment Trust — official actual-holdings JSON API, plain HTTP
// POST, no headless browser, no cookie for the daily path. Verified 2026-09-26:
//   POST https://www.fsitc.com.tw/WebAPI.aspx/Get_hd  {pStrFundID, pStrDate:""}
// returns real per-security holdings grouped by asset type, keyed by the issuer's internal FundDetail ID
// (not the market ticker). Confirmed real total positions (not a creation-basket): share/contract/par-
// value magnitudes match each fund's actual NAV scale directly (e.g. 00994A: 265,999 TSMC shares against
// a 4.64B TWD fund) — no scaling applied or needed.
//
// Identity model: the ticker->FundDetail-ID map is a one-time, low-frequency lookup, never repeated by
// daily ingestion. ETFList.aspx only reveals its FundDetail.aspx links after a real ASP.NET postback
// triggered by clicking the page's own "同意" LinkButton (#ContentPlaceHolder1_LinkButton1) — checking
// the disclaimer's #checkAgree checkbox alone does nothing, since it has no click/change handler at all;
// that was the previous adapter's exact bug (FIRST_ETF_LIST_PARSE_FAILED for all 6, every time). Each
// resulting FundDetail.aspx?ID=X page's own "股票代號" label was then read via plain HTTP (no browser) to
// get its real ticker. The 6 IDs below are that one-time harvest's result (2026-09-26) — re-derive the
// same way only if the issuer adds/removes an ETF, never guessed or hand-edited individually.
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.fsitc.com.tw";

const FUND_ID_MAP: Record<string, string> = {
  "00994A": "182", "00408A": "183", "00728": "D90",
  "00910": "167", "00834B": "101", "00981B": "177",
};

type HdRow = { fundid: string; sdate: string; group: string; A: string; B: string; C: string; D: string; E: string };
type BuySellARow = { A: string; B: string };

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[A-Z]+|[,%]/g, "").trim()) || 0;
}

async function callWebApi<T>(method: string, fundID: string): Promise<T> {
  const r = await fetch(`${BASE}/WebAPI.aspx/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ pStrFundID: fundID, pStrDate: "" }),
  });
  if (!r.ok) throw new Error(`FIRST_HTTP_${r.status}_${method}`);
  const j = await r.json();
  return JSON.parse(j.d) as T;
}

export const FirstOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "First",

  async fetchSnapshot(etfCode: string): Promise<CanonicalSnapshot> {
    const fundID = FUND_ID_MAP[etfCode];
    if (!fundID) throw new Error(`FIRST_UNMAPPED_ETF_${etfCode} — not in the official FundDetail-ID map, never guessed`);

    const [hd, meta] = await Promise.all([
      callWebApi<HdRow[]>("Get_hd", fundID),
      callWebApi<BuySellARow[]>("Get_BuySellA", fundID),
    ]);
    if (!hd.length) throw new Error(`FIRST_NO_HOLDINGS_${etfCode}`);
    // Get_BuySellA is used only for fund-level NAV/outstanding-units values — its own `sdate` (a query/
    // settlement date) is never used as the holdings date.
    const metaMap = new Map(meta.map((m) => [m.A, m.B]));
    const fundNav = num(metaMap.get("基金淨資產價值(元)"));
    const outstandingUnits = num(metaMap.get("已發行受益權單位總數-台幣交易") ?? metaMap.get("已發行受益權單位總數"));

    // groups 4/5/7 are fund-level asset/category summaries, never individual security positions.
    const stockRows = hd.filter((r) => r.group === "1");
    const futureRows = hd.filter((r) => r.group === "2");
    const bondRows = hd.filter((r) => r.group === "6");
    if (!stockRows.length && !futureRows.length && !bondRows.length) {
      throw new Error(`FIRST_NO_HOLDINGS_${etfCode}`);
    }

    const positions: CanonicalPosition[] = [
      ...stockRows.map((r) => ({
        securityCode: r.A, securityName: r.B,
        positionType: "EQUITY" as const, positionAmount: num(r.D), positionUnit: "SHARES" as const,
        weight: num(r.C), canonicalSecurityId: null,
      })),
      ...futureRows.map((r) => ({
        securityCode: r.A, securityName: r.A,
        positionType: "FUTURE" as const, positionAmount: num(r.C), positionUnit: "CONTRACTS" as const,
        weight: num(r.B), canonicalSecurityId: null,
      })),
      ...bondRows.map((r) => ({
        securityCode: r.A, securityName: r.B,
        // Official par value is field C; field D (market value) is never used as the position amount.
        positionType: "BOND" as const, positionAmount: num(r.C), positionUnit: "PAR_VALUE" as const,
        weight: num(r.E), canonicalSecurityId: null,
      })),
    ];

    // Real per-fund holdings date — Get_hd's own `sdate`, never Get_BuySellA's query/settlement date and
    // never computed locally. All rows for one fetch share the same sdate; take it from the first row.
    const dataDate = hd[0].sdate;

    return {
      etfCode,
      issuer: "First",
      assetType:
        stockRows.length && bondRows.length ? "MULTI_ASSET" :
        bondRows.length ? "BOND" :
        stockRows.length ? "EQUITY" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav,
      outstandingUnits,
      positions,
      source: "FIRST_OFFICIAL_WEBAPI",
      retrievedAt: new Date().toISOString(),
    };
  },
};
