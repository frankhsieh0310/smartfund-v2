// Mega (兆豐) Securities Investment Trust — official actual-holdings page, plain HTTP GET, no headless
// browser, no cookie. Verified 2026-09-26:
//   https://www.megafunds.com.tw/MEGA/etf/etf_product.aspx?id=<fund_id>
// is a genuinely separate official page ("持股比重"/基金配置) from the PCF page (trade_pcf.aspx),
// server-rendered, full portfolio in one response (no "load more" needed — a row near the end of the
// visibly-truncated list is already present in the raw HTML). Cross-validated against trade_pcf.aspx for
// 00996A: identical figures on both pages, confirming these are real total positions, never a
// creation-basket requiring scaling.
import * as cheerio from "cheerio";
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.megafunds.com.tw/MEGA/etf/etf_product.aspx";

// market ticker -> official internal fund_id. Captured verbatim from the official ETF overview page
// (https://www.megafunds.com.tw/MEGA/etf/index.aspx), whose per-ticker tiles carry `data-uid="<fund_id>"`
// directly alongside the visible ticker text — cross-verified against trade_pcf.aspx's own `#fund_id`
// dropdown values (one-time read 2026-09-26, never guessed). fund_id=24 ("兆豐美國黃金礦業ETF基金")
// exists in that dropdown but has no ticker tile yet on the overview page — a new/unlisted entrant,
// deliberately excluded until it has an official ticker to map.
const FUND_ID_MAP: Record<string, string> = {
  "00943": "20", "00932": "19", "00921": "18", "00913": "17", "00690": "5",
  "00911": "16", "00957B": "21", "00982T": "22", "00996A": "23",
};

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").trim()) || 0;
}

// Explicitly named per the diagnosis task, plus any other response header that looks like a WAF/CDN/
// proxy marker — never anything that could carry a credential. Only consulted on a non-2xx response;
// the normal 200 path never builds or logs this.
const MEGA_DIAGNOSTIC_HEADER_ALLOWLIST = ["server", "via", "x-cache", "cf-ray", "cf-cache-status", "content-type", "content-length"];
const MEGA_SENSITIVE_HEADER_PATTERN = /cookie|authoriz|token|secret|session|api-key/i;

/** Builds a safe-to-log diagnostic string for a non-2xx Mega response — status/timing/URL plus a
 * curated set of WAF/CDN/proxy-identifying response headers and a short body preview. Never includes
 * Authorization/Cookie/any header matching MEGA_SENSITIVE_HEADER_PATTERN, and never the full body. */
function buildMegaErrorDiagnostics(res: Response, url: string, fundId: string, elapsedMs: number, bodyText: string): string {
  const headerPairs: string[] = [];
  for (const key of MEGA_DIAGNOSTIC_HEADER_ALLOWLIST) {
    const v = res.headers.get(key);
    if (v) headerPairs.push(`${key}=${v}`);
  }
  // Catch other obvious WAF/CDN/proxy markers (vendor-specific header names vary) without an exhaustive
  // per-vendor allowlist — explicitly excluding anything that could be a credential.
  for (const [key, value] of res.headers.entries()) {
    const lower = key.toLowerCase();
    if (MEGA_DIAGNOSTIC_HEADER_ALLOWLIST.includes(lower)) continue; // already captured above
    if (MEGA_SENSITIVE_HEADER_PATTERN.test(lower)) continue; // never log
    if (/waf|cdn|proxy|ray|edge|block|challenge/.test(lower)) headerPairs.push(`${key}=${value}`);
  }
  const bodyPreview = bodyText.slice(0, 300).replace(/\s+/g, " ");
  return `[diag status=${res.status} elapsedMs=${elapsedMs} url=${url} fundId=${fundId} headers={${headerPairs.join(",")}} bodyPreview="${bodyPreview}"]`;
}

export const MegaOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "Mega",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const fundId = FUND_ID_MAP[etfCode];
    if (!fundId) throw new Error(`MEGA_UNMAPPED_ETF_${etfCode} — not in the official data-uid map, never guessed`);

    const url = `${BASE}?id=${fundId}`;
    const startedAt = Date.now();
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal });
    if (!r.ok) {
      const elapsedMs = Date.now() - startedAt;
      const bodyText = await r.text().catch(() => "");
      throw new Error(`MEGA_HTTP_${r.status}_${etfCode} ${buildMegaErrorDiagnostics(r, url, fundId, elapsedMs, bodyText)}`);
    }
    const html = await r.text();

    // The page's own "資料來源：兆豐投信，YYYY/MM/DD" label — never today, never trade_pcf.aspx's query
    // date, never one shared issuer-wide date (confirmed per-ETF: e.g. 00996A=2026/09/24 vs
    // 00957B=2026/09/23 on the same day).
    const dateMatch = html.match(/資料來源：兆豐投信，(\d{4}\/\d{2}\/\d{2})/);
    if (!dateMatch) throw new Error(`MEGA_NO_DATE_${etfCode} — page markup changed, adapter needs re-verification`);
    const dataDate = dateMatch[1].replaceAll("/", "-");

    const navMatch = html.match(/淨資產價值[\s\S]{0,80}?([\d,]+)\s*<\/div>/);
    const unitsMatch = html.match(/在外流通單位數[\s\S]{0,80}?([\d,]+)\s*<\/div>/);

    const $ = cheerio.load(html);
    const cellsOf = (el: Parameters<typeof $>[0]) => $(el).find(".fund-content").map((_, c) => $(c).text().trim()).get();

    const positions: CanonicalPosition[] = [
      ...$(".fund-info.content-list-1").map((_, el) => {
        const c = cellsOf(el); // 股票代號 / 股票名稱 / 股數 / 持股權重
        return { securityCode: c[0], securityName: c[1], positionType: "EQUITY" as const, positionAmount: num(c[2]), positionUnit: "SHARES" as const, weight: num(c[3]), canonicalSecurityId: null };
      }).get(),
      ...$(".fund-info.content-list-6").map((_, el) => {
        const c = cellsOf(el); // 債券代號 / 債券名稱 / 面額 / 市值 / 持股權重(%)
        // Official par value is 面額 (c[2]); 市值 (market value, c[3]) is never used as the position amount.
        return { securityCode: c[0], securityName: c[1], positionType: "BOND" as const, positionAmount: num(c[2]), positionUnit: "PAR_VALUE" as const, weight: num(c[4]), canonicalSecurityId: null };
      }).get(),
      ...$(".fund-info.content-list-2").map((_, el) => {
        const c = cellsOf(el); // 期貨代號 / 期貨名稱 / 契約年月 / 口數 / 持股權重
        return { securityCode: c[0], securityName: c[1], positionType: "FUTURE" as const, positionAmount: num(c[3]), positionUnit: "CONTRACTS" as const, weight: num(c[4]), canonicalSecurityId: null };
      }).get(),
    ];
    if (!positions.length) throw new Error(`MEGA_NO_HOLDINGS_${etfCode}_${dataDate}`);

    return {
      etfCode,
      issuer: "Mega",
      assetType:
        positions.some((p) => p.positionType === "EQUITY") && positions.some((p) => p.positionType === "BOND") ? "MULTI_ASSET" :
        positions.some((p) => p.positionType === "BOND") ? "BOND" :
        positions.some((p) => p.positionType === "EQUITY") ? "EQUITY" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav: num(navMatch?.[1]),
      outstandingUnits: num(unitsMatch?.[1]),
      positions,
      source: "MEGA_OFFICIAL_ACTUAL_HOLDINGS_PAGE",
      retrievedAt: new Date().toISOString(),
    };
  },
};
