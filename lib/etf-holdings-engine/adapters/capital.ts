// Capital (群益) Securities Investment Trust — official actual-holdings JSON API, plain HTTP POST, no
// headless browser, no cookie. Verified 2026-09-25:
//   - https://www.capitalfund.com.tw/CFWeb/api/etf/list (POST, no body) returns every official product's
//     {stockNo, fundNo} in one call — the authoritative ticker->fundNo map (28/28, replaces the previous
//     sitemap-probing discovery, which silently missed entries).
//   - https://www.capitalfund.com.tw/CFWeb/api/etf/buyback (POST {fundId}) returns the fund's actual
//     holdings as typed arrays (stocks/bonds/futures/rps/assets) — confirmed identical to the site's own
//     separately-labeled "申購買回清單" page for the same fund, and realistic in scale vs. fund NAV, so
//     these are real total positions, never a creation-basket requiring scaling.
// This replaces the previous /etf/product/detail/{id}/portfolio HTML scraper entirely — that parser only
// matched a rigid `.tr.show-for-medium` row shape, which leveraged/inverse funds' futures and repo-bond
// sections don't use, causing real holdings to be silently parsed as empty (CAPITAL_NO_HOLDINGS for
// 00685L/00686R even though both hold real futures + repo-bond collateral positions).
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.capitalfund.com.tw/CFWeb/api";

type StockRow = { stocNo: string; stocName: string; share: number; weight: number };
type BondRow = { bondNo: string; bondName: string; faceValue: number; weight: number };
type FutureRow = { txDesc: string; lot: number; weight: number };
type RpRow = { bondsName: string; bondsMoney: string; bondsEname: string };
type AssetRow = { asDesc: string; asMoney: string; asEname: string };
type BuybackResponse = {
  code: number;
  data: {
    pcf: { fundName: string; date1: string; date2: string; nav: number; totUnit: number };
    stocks: StockRow[]; bonds: BondRow[]; futures: FutureRow[]; rps: RpRow[]; assets: AssetRow[];
  } | null;
};
type ListResponse = { code: number; data: { funds: { stockNo: string; fundNo: string }[] } };

function numFromMoneyString(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[A-Z]+/g, "").replace(/,/g, "").trim()) || 0;
}

// Official `asMoney` strings are "<ISO CURRENCY> <amount>" (e.g. "USD 20,320.17"). Used only to build a
// stable identity for cash rows — never to compute or store the position amount itself.
function currencyFromMoneyString(s: string | undefined | null): string | null {
  const m = s?.match(/^([A-Z]{3})\s/);
  return m ? m[1] : null;
}

let fundNoMapCache: Map<string, string> | null = null;
async function resolveFundNoMap(signal?: AbortSignal): Promise<Map<string, string>> {
  if (fundNoMapCache) return fundNoMapCache;
  const r = await fetch(`${BASE}/etf/list`, { method: "POST", signal });
  if (!r.ok) throw new Error(`CAPITAL_HTTP_${r.status}_LIST`);
  const j: ListResponse = await r.json();
  const map = new Map<string, string>();
  for (const f of j.data.funds) map.set(f.stockNo, f.fundNo);
  if (!map.size) throw new Error("CAPITAL_LIST_PARSE_FAILED — official etf/list API response shape changed, adapter needs re-verification");
  fundNoMapCache = map;
  return map;
}

// Each attempt's own internal cap — well under the route's 45s per-ticker total budget, leaving room
// for one retry within that same outer budget. Confirmed live (00946: a single buyback request takes
// ~72ms normally) that Production's "This operation was aborted" (runtimeMs≈49624 ≈ the route's own
// 45s AbortController + fixed overhead) was a one-shot transient stall, not a structural slow-response
// or data-size issue — so a single bounded retry, not a longer timeout, is the right fix.
const CAPITAL_BUYBACK_ATTEMPT_TIMEOUT_MS = 18_000;

type BuybackAttemptResult =
  | { ok: true; res: Response }
  | { ok: false; retryable: boolean; error: Error };

/** One attempt at the buyback POST, bounded by whichever is SMALLER: its own internal timeout, or
 * whatever's left of the caller's outer AbortSignal (the route's own per-ticker/global deadline —
 * aborting here never outlives or extends that budget, both attempts share it). Only a network-level
 * failure or an internal-timeout abort (never the OUTER signal firing — that means the ticker's whole
 * budget is spent, not a transient blip) or a 5xx response is retryable; 403/404/any other 4xx is not. */
async function attemptBuyback(etfCode: string, fundId: string, outerSignal?: AbortSignal): Promise<BuybackAttemptResult> {
  const attemptController = new AbortController();
  const onOuterAbort = () => attemptController.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => attemptController.abort(), CAPITAL_BUYBACK_ATTEMPT_TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}/etf/buyback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fundId }),
      signal: attemptController.signal,
    });
    if (!r.ok) {
      const retryable = r.status >= 500 && r.status < 600;
      return { ok: false, retryable, error: new Error(`CAPITAL_HTTP_${r.status}_${etfCode}`) };
    }
    return { ok: true, res: r };
  } catch (e) {
    // The outer signal firing means this ticker's whole route-level budget is spent — matches
    // route.ts's own "deadline already fired, don't retry" rule, never retried here either.
    const retryable = !outerSignal?.aborted;
    return { ok: false, retryable, error: e instanceof Error ? e : new Error(String(e)) };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

async function fetchBuybackWithBoundedRetry(etfCode: string, fundId: string, outerSignal?: AbortSignal): Promise<Response> {
  const first = await attemptBuyback(etfCode, fundId, outerSignal);
  if (first.ok) return first.res;
  if (!first.retryable) throw first.error;
  const second = await attemptBuyback(etfCode, fundId, outerSignal);
  if (second.ok) return second.res;
  throw second.error;
}

export const CapitalOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "Capital",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const map = await resolveFundNoMap(signal);
    const fundId = map.get(etfCode);
    if (!fundId) throw new Error(`CAPITAL_UNMAPPED_ETF_${etfCode} — not in the official etf/list map, never guessed`);

    const r = await fetchBuybackWithBoundedRetry(etfCode, fundId, signal);
    const j: BuybackResponse = await r.json();
    if (j.code !== 200 || !j.data) throw new Error(`CAPITAL_BUYBACK_FAILED_${etfCode}`);
    const { pcf, stocks, bonds, futures, rps, assets } = j.data;
    if (!pcf.date2) throw new Error(`CAPITAL_NO_DATE_${etfCode} — official pcf.date2 missing, response shape changed`);

    const positions: CanonicalPosition[] = [
      ...stocks.map((s) => ({
        securityCode: s.stocNo, securityName: s.stocName,
        positionType: "EQUITY" as const, positionAmount: s.share, positionUnit: "SHARES" as const,
        weight: s.weight, canonicalSecurityId: null,
      })),
      ...bonds.map((b) => ({
        securityCode: b.bondNo, securityName: b.bondName,
        // Official par value is `faceValue`; `marketValue` is never used as the position amount.
        positionType: "BOND" as const, positionAmount: b.faceValue, positionUnit: "PAR_VALUE" as const,
        weight: b.weight, canonicalSecurityId: null,
      })),
      ...futures.map((f) => ({
        securityCode: f.txDesc, securityName: f.txDesc,
        positionType: "FUTURE" as const, positionAmount: f.lot, positionUnit: "CONTRACTS" as const,
        weight: f.weight, canonicalSecurityId: null,
      })),
      // Repo-bond collateral (rps) has no security code, ISIN, or par-value field — only a descriptive
      // name and a TWD notional amount — so it is never forced into BOND/PAR_VALUE, per the official-
      // fields-only rule.
      ...rps.map((rp) => ({
        securityCode: rp.bondsName, securityName: rp.bondsEname || rp.bondsName,
        positionType: "OTHER" as const, positionAmount: numFromMoneyString(rp.bondsMoney), positionUnit: "OTHER" as const,
        weight: 0, canonicalSecurityId: null,
      })),
      // Cash rows (asDesc "現金" / asEname "Cash") get a currency-qualified synthetic identity
      // (CASH:TWD, CASH:USD, ...) because the same fund can hold cash in more than one official
      // currency simultaneously, and the official API labels every one of them identically as "現金" —
      // a bare asDesc-as-code would collide across currencies and silently drop a real balance. The
      // identity is derived only from the ISO currency code in asMoney, never from the amount itself,
      // so it stays stable day to day. Non-cash asset rows (保證金/應付贖回款/etc.) keep asDesc as their
      // code unchanged, since they haven't been observed to collide.
      ...assets.map((a) => {
        const isCash = a.asDesc === "現金" || a.asEname === "Cash";
        const currency = isCash ? currencyFromMoneyString(a.asMoney) : null;
        return {
          securityCode: currency ? `CASH:${currency}` : a.asDesc,
          securityName: a.asEname || a.asDesc,
          positionType: "OTHER" as const, positionAmount: numFromMoneyString(a.asMoney), positionUnit: "OTHER" as const,
          weight: 0, canonicalSecurityId: null,
        };
      }),
    ];
    if (!positions.length) throw new Error(`CAPITAL_NO_HOLDINGS_${etfCode}_${pcf.date2}`);

    const dataDate = pcf.date2;
    return {
      etfCode,
      issuer: "Capital",
      assetType:
        stocks.length && bonds.length ? "MULTI_ASSET" :
        bonds.length ? "BOND" :
        stocks.length ? "EQUITY" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav: pcf.nav,
      outstandingUnits: pcf.totUnit,
      positions,
      source: "CAPITAL_OFFICIAL_ACTUAL_HOLDINGS_API",
      retrievedAt: new Date().toISOString(),
    };
  },
};
