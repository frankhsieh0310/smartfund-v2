// Uni-President Assets Management (統一投信) — official public PCF/holdings API. Verified 2026-09-24/25:
// no auth, no cookie required for the fund-list page; a lightweight session cookie is needed for the
// data POST. Same endpoint works unmodified for every UPAMC ETF, active or passive — only the internal
// fundCode changes, and that fundCode is resolved live from the official fund-picker dropdown, never
// hardcoded or guessed.
import type { CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.ezmoney.com.tw";

type UniAssetDetail = { DetailCode: string; DetailName: string; Share: number; Amount: number; NavRate: number; MTH: string; TranDate: string };
type UniAssetGroup = { AssetCode: string; AssetName: string; Value: number; Details: UniAssetDetail[] | null };
type UniPcfRow = { PCFCode: string; Amount: number; PostDate: string };
type UniGetPcfResponse = { pcf: UniPcfRow[]; asset: UniAssetGroup[] };

function toIso(dotnetDateOrIso: string): string {
  const m = /\/Date\((\d+)\)\//.exec(dotnetDateOrIso);
  if (m) {
    const d = new Date(Number(m[1]));
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  return dotnetDateOrIso.slice(0, 10);
}

function rocToIsoDate(roc: string): string {
  const [y, m, d] = roc.split("/");
  return `${Number(y) + 1911}-${m}-${d}`;
}

let cachedCookie: string | null = null;
async function getSessionCookie(signal?: AbortSignal): Promise<string> {
  if (cachedCookie) return cachedCookie;
  let url = `${BASE}/ETF/Transaction/PCF`;
  const cookies: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await fetch(url, { redirect: "manual", headers: cookies.length ? { Cookie: cookies.join("; ") } : {}, signal });
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) cookies.push(setCookie.split(";")[0]);
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) break;
      url = new URL(loc, url).toString();
      continue;
    }
    break;
  }
  if (!cookies.length) throw new Error("UPAMC_NO_SESSION_COOKIE — site behavior changed, adapter needs re-verification");
  cachedCookie = cookies.join("; ");
  return cachedCookie;
}

let fundCodeMapCache: Map<string, string> | null = null;
let defaultQueryDateCache: string | null = null;
/** Resolves ticker -> UPAMC's internal fundCode straight from the official page's own NAV table, whose
 * per-fund links are server-rendered as `<a href="/ETF/Fund/Info?fundCode=XXXXX">00939 名稱</a>` — the
 * fund-picker <select>'s own options are client-JS-injected and not present in the raw HTML, but this
 * table carries the identical mapping. Never hardcoded, never guessed. Cached for the process lifetime.
 *
 * The same page also server-renders the query-date input (`#ED`) pre-filled with the site's own current
 * default query date. Root-caused 2026-09-25: GetPCF has no data for "today" (or the calendar days right
 * after it — confirmed empirically across several) — only for whatever date this input actually defaults
 * to, which the site computes server-side (next valid PCF-query date, not a fixed day offset). Captured
 * here alongside the fund map from the same one HTML fetch, never computed locally. */
async function ensureFundListLoaded(signal?: AbortSignal): Promise<void> {
  if (fundCodeMapCache) return;
  const cookie = await getSessionCookie(signal);
  const r = await fetch(`${BASE}/ETF/Transaction/PCF`, { headers: { Cookie: cookie }, signal });
  if (!r.ok) throw new Error(`UPAMC_HTTP_${r.status}_FUNDLIST`);
  const html = await r.text();
  const map = new Map<string, string>();
  // <a title="00939 統一台灣高息動能" href="/ETF/Fund/Info?fundCode=46YTW">00939 統一台灣高息動能</a>
  const re = /href="\/ETF\/Fund\/Info\?fundCode=([A-Za-z0-9]+)">\s*(\d{4,6}[A-Z]?)\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) map.set(m[2], m[1]);
  if (!map.size) throw new Error("UPAMC_FUND_LIST_PARSE_FAILED — site markup changed, adapter needs re-verification");
  fundCodeMapCache = map;

  const dateMatch = html.match(/id="ED"[^>]*value="(\d{3}\/\d{2}\/\d{2})"/);
  if (!dateMatch) throw new Error("UPAMC_NO_DEFAULT_QUERY_DATE — official #ED input missing, site markup changed");
  defaultQueryDateCache = dateMatch[1];
}

async function resolveFundCode(etfCode: string, signal?: AbortSignal): Promise<string> {
  await ensureFundListLoaded(signal);
  const code = fundCodeMapCache!.get(etfCode);
  if (!code) throw new Error(`UPAMC_UNMAPPED_ETF_${etfCode} — not found in official dropdown, never guessed`);
  return code;
}

async function resolveDefaultQueryDate(signal?: AbortSignal): Promise<string> {
  await ensureFundListLoaded(signal);
  return defaultQueryDateCache!;
}

export const UpamcOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "UPAMC",

  async fetchSnapshot(etfCode: string, rocDate?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const fundCode = await resolveFundCode(etfCode, signal);
    const date = rocDate ?? await resolveDefaultQueryDate(signal);

    const cookie = await getSessionCookie(signal);
    const r = await fetch(`${BASE}/ETF/Transaction/GetPCF`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ fundCode, date, specificDate: true }),
      signal,
    });
    if (!r.ok) throw new Error(`UPAMC_HTTP_${r.status}`);
    const j: UniGetPcfResponse = await r.json();

    const stockGroup = j.asset?.find((a) => a.AssetCode === "ST");
    const bondGroup = j.asset?.find((a) => a.AssetCode === "BD");
    const futureGroup = j.asset?.find((a) => a.AssetCode === "GD");
    const stocks = stockGroup?.Details ?? [];
    const bonds = bondGroup?.Details ?? [];
    const futures = futureGroup?.Details ?? [];
    if (!stocks.length && !bonds.length) throw new Error(`UPAMC_NO_HOLDINGS_${etfCode}_${date}`);

    const navRow = j.pcf?.find((p) => p.PCFCode === "NAV");
    const outUnitRow = j.pcf?.find((p) => p.PCFCode === "OUT_UNIT");
    const fundNav = navRow?.Amount ?? 0;
    const outstandingUnits = outUnitRow?.Amount ?? 0;
    const anyRow = stocks[0] ?? bonds[0];
    const dataDate = toIso(anyRow.TranDate);
    const announcementDate = rocToIsoDate(date);

    return {
      etfCode,
      issuer: "UPAMC",
      assetType: bonds.length && !stocks.length ? "BOND" : "EQUITY",
      dataDate,
      announcementDate,
      fundNav,
      outstandingUnits,
      positions: [
        ...stocks.map((s) => ({
          securityCode: s.DetailCode, securityName: s.DetailName,
          positionType: "EQUITY" as const, positionAmount: s.Share, positionUnit: "SHARES" as const,
          weight: s.NavRate, canonicalSecurityId: null,
        })),
        ...bonds.map((b) => ({
          securityCode: b.DetailCode, securityName: b.DetailName,
          positionType: "BOND" as const, positionAmount: b.Amount, positionUnit: "PAR_VALUE" as const,
          weight: b.NavRate, canonicalSecurityId: null,
        })),
        ...futures.map((f) => ({
          securityCode: f.DetailCode, securityName: f.DetailName,
          positionType: "FUTURE" as const, positionAmount: f.Share, positionUnit: "CONTRACTS" as const,
          weight: f.NavRate, canonicalSecurityId: null,
        })),
      ],
      source: "UPAMC_OFFICIAL_API",
      retrievedAt: new Date().toISOString(),
    };
  },
};
