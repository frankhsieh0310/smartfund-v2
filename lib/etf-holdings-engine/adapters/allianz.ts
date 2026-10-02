// Allianz Global Investors Taiwan — official actual-holdings JSON API, plain HTTP POST, no headless
// browser. Verified 2026-09-26:
//   1. GET  /webapi/api/AntiForgery/GetAntiForgeryToken           -> {token, maxAgeSeconds:86400} + sets
//      the matching `.AspNetCore.Antiforgery.*` cookie. ASP.NET Core double-submit CSRF pattern — the same
//      token value must be sent both as the `X-XSRF-TOKEN` header and via the cookie on every subsequent
//      call. Token/cookie pair lasts 24h, so it is bootstrapped once per process run, not per ETF.
//   2. POST /webapi/api/Fund/GetFundAssets  {"FundID": "<official FundNo>"}
//      returns the fund's actual holdings directly: FundAsset.NavDate is the real per-fund holdings date
//      (FundAsset.PCFDate is a separate query/settlement date, confirmed distinct — e.g. NavDate
//      2026/09/24 vs PCFDate 2026/09/29 on the same call — and is never used as the holdings date). No
//      separate PCF/creation-basket endpoint was found anywhere in this issuer's site; GetFundAssets is
//      the direct and only holdings source, and its magnitudes (e.g. 349,000 TSMC shares for a ~10B TWD
//      fund) already match real total-portfolio scale, so nothing is scaled.
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://etf.allianzgi.com.tw/webapi";

// market ticker -> official internal FundNo. Captured verbatim from
// POST /webapi/api/Category/GetFundDropdownOptions {"TypeId":6} (one-time read 2026-09-26, never
// guessed). Re-derive from the same endpoint if the issuer adds/removes an ETF.
const FUND_ID_MAP: Record<string, string> = {
  "00984A": "E0001", "00993A": "E0002", "00402A": "E0003",
};

type FundAsset = { Aum: string; Units: string; Nav: string; NavDate: string; PCFDate: string };
type TableColumn = { Name: string | null };
type AssetTable = { TableTitle: string; Columns: TableColumn[]; Rows: string[][] };
type GetFundAssetsResponse = { Entries: { FundID: string | null; Data: { FundAsset: FundAsset | null; Table: AssetTable[] } }; Message: string };

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").replace(/^TWD\$/, "").trim()) || 0;
}

let tokenCache: { token: string; cookie: string; expiresAt: number } | null = null;
async function getAntiForgeryContext(): Promise<{ token: string; cookie: string }> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache;
  const r = await fetch(`${BASE}/api/AntiForgery/GetAntiForgeryToken`);
  if (!r.ok) throw new Error(`ALLIANZ_HTTP_${r.status}_ANTIFORGERY`);
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : ([r.headers.get("set-cookie") ?? ""].filter(Boolean));
  if (!setCookies.length) throw new Error("ALLIANZ_NO_ANTIFORGERY_COOKIE — site behavior changed, adapter needs re-verification");
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  const j: { token: string; maxAgeSeconds: number } = await r.json();
  if (!j.token) throw new Error("ALLIANZ_NO_ANTIFORGERY_TOKEN — site behavior changed, adapter needs re-verification");
  tokenCache = { token: j.token, cookie, expiresAt: Date.now() + j.maxAgeSeconds * 1000 - 60_000 };
  return tokenCache;
}

async function postWithToken<T>(path: string, body: unknown): Promise<T> {
  const { token, cookie } = await getAntiForgeryContext();
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token, Cookie: cookie },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ALLIANZ_HTTP_${r.status}_${path}`);
  return r.json() as Promise<T>;
}

export const AllianzOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "Allianz",

  async fetchSnapshot(etfCode: string): Promise<CanonicalSnapshot> {
    const fundID = FUND_ID_MAP[etfCode];
    if (!fundID) throw new Error(`ALLIANZ_UNMAPPED_ETF_${etfCode} — not in the official GetFundDropdownOptions map, never guessed`);

    const j = await postWithToken<GetFundAssetsResponse>("/api/Fund/GetFundAssets", { FundID: fundID });
    const asset = j.Entries?.Data?.FundAsset;
    const tables = j.Entries?.Data?.Table ?? [];
    if (!asset) throw new Error(`ALLIANZ_NO_HOLDINGS_${etfCode} — ${j.Message || "empty response"}`);
    if (!asset.NavDate) throw new Error(`ALLIANZ_NO_DATE_${etfCode} — official NavDate missing, response shape changed`);
    const dataDate = asset.NavDate.replaceAll("/", "-");

    const positions: CanonicalPosition[] = [];
    for (const table of tables) {
      const colNames = table.Columns.map((c) => c.Name);
      if (colNames.includes("股票代號")) {
        const codeIdx = colNames.indexOf("股票代號"), nameIdx = colNames.indexOf("股票名稱");
        const shareIdx = colNames.indexOf("股數"), weightIdx = colNames.indexOf("權重(%)");
        for (const row of table.Rows) {
          positions.push({
            securityCode: row[codeIdx], securityName: row[nameIdx],
            positionType: "EQUITY", positionAmount: num(row[shareIdx]), positionUnit: "SHARES",
            weight: num(row[weightIdx]), canonicalSecurityId: null,
          });
        }
      } else if (colNames.includes("債券代號")) {
        const codeIdx = colNames.indexOf("債券代號"), nameIdx = colNames.indexOf("債券名稱");
        const parIdx = colNames.indexOf("面額"), weightIdx = colNames.indexOf("權重(%)");
        for (const row of table.Rows) {
          positions.push({
            securityCode: row[codeIdx], securityName: row[nameIdx],
            positionType: "BOND", positionAmount: num(row[parIdx]), positionUnit: "PAR_VALUE",
            weight: num(row[weightIdx]), canonicalSecurityId: null,
          });
        }
      } else if (colNames.includes("期貨代號")) {
        const codeIdx = colNames.indexOf("期貨代號"), nameIdx = colNames.indexOf("期貨名稱");
        const lotIdx = colNames.indexOf("口數"), weightIdx = colNames.indexOf("權重(%)");
        for (const row of table.Rows) {
          positions.push({
            securityCode: row[codeIdx], securityName: row[nameIdx],
            positionType: "FUTURE", positionAmount: num(row[lotIdx]), positionUnit: "CONTRACTS",
            weight: num(row[weightIdx]), canonicalSecurityId: null,
          });
        }
      }
      // Any other table (the unlabeled summary table) is a fund-level asset-category aggregate, never
      // individual security positions — deliberately skipped.
    }
    if (!positions.length) throw new Error(`ALLIANZ_NO_HOLDINGS_${etfCode}_${dataDate}`);

    const hasBond = positions.some((p) => p.positionType === "BOND");
    const hasEquity = positions.some((p) => p.positionType === "EQUITY");
    return {
      etfCode,
      issuer: "Allianz",
      assetType: hasBond && hasEquity ? "MULTI_ASSET" : hasBond ? "BOND" : hasEquity ? "EQUITY" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav: num(asset.Aum),
      outstandingUnits: num(asset.Units),
      positions,
      source: "ALLIANZ_OFFICIAL_FUND_ASSETS_API",
      retrievedAt: new Date().toISOString(),
    };
  },
};
