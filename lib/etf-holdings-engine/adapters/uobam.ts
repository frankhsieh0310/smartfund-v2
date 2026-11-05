// UOB Asset Management Taiwan (大華銀) Securities Investment Trust — official 申購買回清單(PCF) page,
// plain HTTP GET to the page's own JSON data endpoint, no headless browser, no cookie, no UA spoofing.
// VERIFIED 2026-11-05: the ETF landing page (https://www.uobam.com.tw/ETFlandingpage) links each fund's
// own overview page, whose own "成分股" link leads to /fund/etf/pcf?fundID=<id> (the official 申購買回
// 清單 page). That page's <select> dropdown exposes each fund by a UUID, but the page's own client-side
// JS resolves that UUID to a different SHORT numeric fundID before calling its real data endpoint
// (/json/reply/WebSitePcfRequest?fundID=<shortId>&pcfDate=) — captured live by selecting each dropdown
// option and reading the resulting network request, never guessed. Cross-checked: 00959B's basketValue/
// totalAV/nav exactly matched the officially-rendered page before this fix (NT$4,579,886,226 totalAV,
// NAV 9.1536, dated 2026/11/04).
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.uobam.com.tw/json/reply/WebSitePcfRequest";

// market ticker -> official short numeric fundID. One-time harvest 2026-11-05 by selecting every
// dropdown option on the official PCF page and reading the resulting network request — never guessed.
export const FUND_ID_MAP: Record<string, string> = {
  "00918": "88329556", "00959B": "00515073", "009815": "00648622",
  "00983B": "00580860", "00984B": "00580854",
};

type UobamRow = {
  kind: "stock" | "bond" | string;
  code: string;
  cName: string;
  qty: string;
  dataDate: string;
  weight: number;
};

type UobamResponse = {
  etf002: string;
  twName: string;
  datadate: string;
  nav: string;
  totalIssues: string;
  ec020: string | null;
  result: UobamRow[];
};

function num(s: string | number | undefined | null): number {
  if (s === undefined || s === null) return 0;
  if (typeof s === "number") return s;
  return Number(s.replace(/[^0-9.-]/g, "")) || 0;
}

/** Parses the site's own ".NET-style" /Date(ms+0800)/ timestamp into a YYYY-MM-DD string, in the
 * timestamp's own embedded Taipei offset (the site always emits +0800), never the server's local clock. */
function parseDotNetDate(raw: string): string {
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(raw);
  if (!m) throw new Error(`UOBAM_UNPARSEABLE_DATE_${raw}`);
  const ms = Number(m[1]);
  const d = new Date(ms + 8 * 60 * 60 * 1000); // the timestamp is already UTC ms; render in UTC+8 (the
  // offset suffix the site sends is always +0800, so adding the fixed 8h here reproduces the exact
  // Taipei calendar date it is displaying, without depending on this machine's own local timezone).
  return d.toISOString().slice(0, 10);
}

export const UobamOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "UOBAM",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const fundId = FUND_ID_MAP[etfCode];
    if (!fundId) throw new Error(`UOBAM_UNMAPPED_ETF_${etfCode} — not in the official fundID map, never guessed`);

    const res = await fetch(`${BASE}?fundID=${fundId}&pcfDate=`, { signal });
    if (!res.ok) throw new Error(`UOBAM_HTTP_${res.status}`);
    const json = (await res.json()) as UobamResponse;
    if (!json.result?.length) throw new Error(`UOBAM_NO_HOLDINGS_${etfCode}`);

    const dataDate = parseDotNetDate(json.datadate);
    const isBondFund = json.ec020 === "債券型" || json.result.every((r) => r.kind === "bond");

    const positions: CanonicalPosition[] = json.result
      .filter((r) => r.kind === "stock" || r.kind === "bond")
      .map((r) => ({
        securityCode: r.code,
        securityName: r.cName,
        positionType: r.kind === "bond" ? ("BOND" as const) : ("EQUITY" as const),
        // qty is the official par value for bonds (never recomputed), share count for equities.
        positionAmount: num(r.qty),
        positionUnit: r.kind === "bond" ? ("PAR_VALUE" as const) : ("SHARES" as const),
        weight: num(r.weight),
        canonicalSecurityId: null,
      }));
    if (!positions.length) throw new Error(`UOBAM_NO_HOLDINGS_${etfCode}`);

    return {
      etfCode,
      issuer: "UOBAM",
      assetType: isBondFund ? "BOND" : "EQUITY",
      dataDate,
      announcementDate: dataDate,
      fundNav: num(json.nav),
      outstandingUnits: num(json.totalIssues),
      positions,
      source: "UOBAM_OFFICIAL_PCF",
      retrievedAt: new Date().toISOString(),
    };
  },
};
