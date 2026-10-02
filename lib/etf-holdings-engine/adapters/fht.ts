// Fuh Hwa (復華) Securities Investment Trust — official JSON API. Verified 2026-09-25 via real Network
// capture: a bare fetch to /api/assets or /api/fundList with no cookie falls back to the site's own
// homepage HTML; the same request carrying the browser's session cookie jar (plus the browser's own
// Referer/Origin/Accept/User-Agent/X-Requested-With) returns real application/json holdings. No headless
// browser is required — one lightweight issuer-level session bootstrap (GET the official ETF page once,
// collect Set-Cookie) is reused for every ETF's fundList + assets calls in a run.
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.fhtrust.com.tw";
const BOOTSTRAP_PATH = "/ETF/etf_detail/ETF23"; // any real official ETF page works as the bootstrap target
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type FundListEntry = { fundID: string; etf002?: string; cname?: string; navDate?: string };
type FundEntry = { fundID: string; latestDataDate: string };
type AssetDetailRow = { ftype: string; stockid: string; stockname: string; qshare: string; mvalue: string; prate_addaccint: string };
type AssetsResponse = { result: [{ dDate: string; pcf_FundNav: string; pcf_FundQissue: string; detail: AssetDetailRow[] }] };

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").trim()) || 0;
}

/** Issuer-level session bootstrap: one plain GET of an official FHT page, collecting every Set-Cookie
 * into a jar reused by every subsequent fundList/assets call in this run. Not per-ETF, not per-call. */
let sessionCookieJar: string | null = null;
async function bootstrapSession(): Promise<string> {
  if (sessionCookieJar) return sessionCookieJar;
  const r = await fetch(`${BASE}${BOOTSTRAP_PATH}`, { headers: { "User-Agent": BROWSER_UA } });
  if (!r.ok) throw new Error(`FHT_HTTP_${r.status}_BOOTSTRAP`);
  // Node's fetch exposes combined Set-Cookie via getSetCookie() when available; fall back to a single header read.
  const cookies = typeof (r.headers as any).getSetCookie === "function"
    ? (r.headers as any).getSetCookie()
    : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie") as string] : []);
  if (!cookies.length) throw new Error("FHT_NO_SESSION_COOKIE — bootstrap page returned no Set-Cookie, site behavior changed");
  const jar: string = cookies.map((c: string) => c.split(";")[0]).join("; ");
  sessionCookieJar = jar;
  return jar;
}

function authedHeaders(cookie: string, referer: string): HeadersInit {
  return {
    Cookie: cookie,
    Referer: referer,
    Origin: BASE,
    Accept: "application/json, text/plain, */*",
    "User-Agent": BROWSER_UA,
    "X-Requested-With": "XMLHttpRequest",
  };
}

let fundMapCache: Map<string, FundEntry> | null = null;
/**
 * Resolves ticker -> { FundID, latestDataDate } from the official fundList, called once per run (not per
 * ETF, not per day) using the bootstrapped session. `navDate` is the fundList's own per-fund "latest
 * available data date" field — confirmed via a bounded check to differ ETF-by-ETF (00409A navDate
 * 2026/09/23 vs 00991A navDate 2026/09/24 on the same call), so it is read per-ticker from this same
 * response, never assumed to be one shared issuer-wide date and never guessed as "today" or "previous
 * business day".
 */
async function resolveFundMap(): Promise<Map<string, FundEntry>> {
  if (fundMapCache) return fundMapCache;
  const cookie = await bootstrapSession();
  const r = await fetch(`${BASE}/api/fundList?ec001=3`, {
    headers: authedHeaders(cookie, `${BASE}${BOOTSTRAP_PATH}`),
  });
  if (!r.ok) throw new Error(`FHT_HTTP_${r.status}_FUNDLIST`);
  const contentType = r.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) throw new Error(`FHT_FUNDLIST_NOT_JSON — got content-type "${contentType}", session bootstrap did not authorize this endpoint`);
  const j: { result: FundListEntry[] } = await r.json();
  const map = new Map<string, FundEntry>();
  for (const f of j.result) {
    if (!f.etf002 || !f.navDate) continue;
    map.set(f.etf002, { fundID: f.fundID, latestDataDate: f.navDate });
  }
  if (!map.size) throw new Error("FHT_FUND_LIST_PARSE_FAILED — API response shape changed, adapter needs re-verification");
  fundMapCache = map;
  return map;
}

function positionTypeOf(ftype: string): { type: CanonicalPosition["positionType"]; unit: CanonicalPosition["positionUnit"] } {
  if (ftype === "股票") return { type: "EQUITY", unit: "SHARES" };
  if (ftype === "債券") return { type: "BOND", unit: "PAR_VALUE" };
  if (ftype === "期貨") return { type: "FUTURE", unit: "CONTRACTS" };
  return { type: "OTHER", unit: "OTHER" };
}

export const FhtOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "FHT",

  async fetchSnapshot(etfCode: string, date?: string): Promise<CanonicalSnapshot> {
    const map = await resolveFundMap();
    const fund = map.get(etfCode);
    if (!fund) throw new Error(`FHT_UNMAPPED_ETF_${etfCode} — not found in official fundList, never guessed`);
    const fundID = fund.fundID;
    // Never default to "today" / calendar run-date. If the caller didn't pin a date, use this ETF's own
    // official latest-available-data-date from fundList — never a shared issuer-wide guess.
    const qDate = date ?? fund.latestDataDate;

    const cookie = await bootstrapSession();
    const referer = `${BASE}/ETF/etf_detail/${fundID}`;
    const r = await fetch(`${BASE}/api/assets?fundID=${fundID}&qDate=${qDate}`, { headers: authedHeaders(cookie, referer) });
    if (!r.ok) throw new Error(`FHT_HTTP_${r.status}_${etfCode}`);
    const contentType = r.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) throw new Error(`FHT_ASSETS_NOT_JSON_${etfCode} — got content-type "${contentType}" instead of json`);
    const j: AssetsResponse = await r.json();
    const entry = j.result?.[0];
    if (!entry) throw new Error(`FHT_NO_ENTRY_${etfCode}_${qDate}`);
    const rows = (entry.detail ?? []).filter((d) => d.stockid);
    // Even the official latest-available date can legitimately have no published detail yet (e.g. NAV
    // published before the PCF detail is). That is a genuine "source not updated yet" condition, not an
    // ingestion failure and never a reason to fall back and mislabel an older snapshot as this date.
    if (!rows.length) throw new Error(`FHT_SOURCE_NOT_UPDATED_YET_${etfCode}_${qDate}`);

    const positions: CanonicalPosition[] = rows.map((row) => {
      const { type, unit } = positionTypeOf(row.ftype);
      return {
        securityCode: row.stockid, securityName: row.stockname,
        positionType: type, positionAmount: num(row.qshare), positionUnit: unit,
        weight: num(row.prate_addaccint), canonicalSecurityId: null,
      };
    });

    return {
      etfCode,
      issuer: "FHT",
      assetType: positions.some((p) => p.positionType === "EQUITY") ? "EQUITY" : positions.some((p) => p.positionType === "BOND") ? "BOND" : "OTHER",
      dataDate: entry.dDate.replaceAll("/", "-"),
      announcementDate: entry.dDate.replaceAll("/", "-"),
      fundNav: num(entry.pcf_FundNav),
      outstandingUnits: num(entry.pcf_FundQissue),
      positions,
      source: "FHT_OFFICIAL_API",
      retrievedAt: new Date().toISOString(),
    };
  },
};
