// Yuanta Securities Investment Trust — official actual-holdings page, plain HTTP, no headless browser, no
// cookie. Verified 2026-09-25: https://www.yuantaetfs.com/tradeInfo/pcf/{ticker} is the PCF creation/
// redemption BASKET (per-creation-unit composition) — it is NOT the fund's actual total holdings and must
// never be used as one (confirmed: its own table only carries basket-level rows, distinct semantics from
// the fund's real position). The real actual-holdings source is
// https://www.yuantaetfs.com/product/detail/{ticker}/ratio (the site's own "持股比重" page). Its visible
// HTML table only server-renders the top 5 rows per asset class, but the FULL official dataset for every
// asset class is already embedded in the same response as a `window.__NUXT__` state payload (a JS object
// literal via Nuxt's variable-deduplication IIFE, not strict JSON) — one plain GET carries the complete
// portfolio, no second request, no "load more" click, no headless browser needed.
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.yuantaetfs.com";

type PcfMeta = {
  markcd: string; trandate: string; totalav: number; osunit: number;
};
type WeightRow = { code: string; name: string; ename?: string; weights: number; qty: number; FACE_AMT?: number; ym?: string };
type FundWeights = {
  StockWeights: WeightRow[]; BondWeights: WeightRow[]; FutureWeights: WeightRow[]; ETFWeights: WeightRow[];
};
type WeightData = { PCF: PcfMeta; FundWeights: FundWeights };

function rocDateToIso(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** Locates and safely evaluates the page's own `window.__NUXT__` state payload. It is a Nuxt
 * variable-deduplication IIFE `(function(a,b,...){ return {...} })(v1,v2,...)` — valid JS, not JSON — so it
 * is evaluated (never regex-scraped field-by-field) against this one trusted first-party HTTP response. */
function extractNuxtState(html: string): any {
  const m = html.match(/<script>window\.__NUXT__=([\s\S]*?)<\/script>/);
  if (!m) throw new Error("YUANTA_NO_NUXT_STATE — page markup changed, adapter needs re-verification");
  return new Function(`return ${m[1]}`)();
}

function findWeightData(nuxtState: any): WeightData {
  const dataBlocks: unknown[] = Array.isArray(nuxtState?.data) ? nuxtState.data : [];
  for (const block of dataBlocks) {
    const wd = (block as { weightData?: WeightData } | null)?.weightData;
    if (wd?.FundWeights && wd?.PCF) return wd;
  }
  throw new Error("YUANTA_NO_WEIGHT_DATA — __NUXT__ state present but no weightData.FundWeights block found");
}

export const YuantaOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "Yuanta",

  async fetchSnapshot(etfCode: string): Promise<CanonicalSnapshot> {
    const r = await fetch(`${BASE}/product/detail/${etfCode}/ratio`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`YUANTA_HTTP_${r.status}_${etfCode}`);
    const html = await r.text();
    const nuxtState = extractNuxtState(html);
    const { PCF: meta, FundWeights: fw } = findWeightData(nuxtState);
    if (!meta?.trandate) throw new Error(`YUANTA_NO_DATE_${etfCode} — official PCF meta had no trandate`);

    const stockRows = fw.StockWeights ?? [];
    const bondRows = fw.BondWeights ?? [];
    const futureRows = fw.FutureWeights ?? [];
    const etfRows = fw.ETFWeights ?? [];
    if (!stockRows.length && !bondRows.length && !futureRows.length && !etfRows.length) {
      throw new Error(`YUANTA_NO_HOLDINGS_${etfCode}_${meta.trandate}`);
    }

    const positions: CanonicalPosition[] = [
      ...stockRows.map((s) => ({
        securityCode: s.code, securityName: s.name,
        positionType: "EQUITY" as const, positionAmount: s.qty, positionUnit: "SHARES" as const,
        weight: s.weights, canonicalSecurityId: null,
      })),
      ...bondRows.map((b) => ({
        securityCode: b.code, securityName: b.name,
        // Official par value is FACE_AMT; `qty` on a bond row is market value, never used as par value.
        positionType: "BOND" as const, positionAmount: b.FACE_AMT ?? 0, positionUnit: "PAR_VALUE" as const,
        weight: b.weights, canonicalSecurityId: null,
      })),
      ...futureRows.map((f) => ({
        // Official rows carry a contract-month field (`ym`, e.g. "202610") alongside the root contract
        // code — a fund can legitimately hold both a near-month and a far-month contract on the same
        // underlying at once, which share the bare code and would otherwise collide.
        securityCode: f.ym ? `FUTURE:${f.code}:${f.ym}` : f.code, securityName: f.name,
        positionType: "FUTURE" as const, positionAmount: f.qty, positionUnit: "CONTRACTS" as const,
        weight: f.weights, canonicalSecurityId: null,
      })),
      ...etfRows.map((e) => ({
        securityCode: e.code, securityName: e.name,
        // No official confirmation that ETFWeights' `qty` is a share/unit count — kept as OTHER/OTHER
        // rather than assumed SHARES, per the official-field-only rule.
        positionType: "OTHER" as const, positionAmount: e.qty, positionUnit: "OTHER" as const,
        weight: e.weights, canonicalSecurityId: null,
      })),
    ];

    const dataDate = rocDateToIso(meta.trandate);
    return {
      etfCode,
      issuer: "Yuanta",
      assetType:
        (stockRows.length || etfRows.length) && bondRows.length ? "MULTI_ASSET" :
        bondRows.length ? "BOND" :
        (stockRows.length || etfRows.length) ? "EQUITY" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav: meta.totalav ?? 0,
      outstandingUnits: meta.osunit ?? 0,
      positions,
      source: "YUANTA_OFFICIAL_ACTUAL_HOLDINGS_PAGE",
      retrievedAt: new Date().toISOString(),
    };
  },
};
