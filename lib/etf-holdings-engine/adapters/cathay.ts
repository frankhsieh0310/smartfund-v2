// Cathay (國泰) Securities Investment Trust — official JSON API, plain HTTP, no headless browser, no
// cookie, no token. Two distinct official endpoint families exist on cwapi.cathaysite.com.tw:
//   - BuySale/GetStocksList|GetBondsList|GetFuturesList: the PCF creation/redemption BASKET (one creation
//     unit's worth of `basketUnit` fund units) — NOT the fund's total holdings.
//   - ETF/GetETFDetailStockList|GetETFDetailBondList|GetETFDetailFutureList (the site's own "持股權重"
//     page): the fund's actual total position per security, official and direct.
// Validated 2026-09-25 against 3 ETFs (00878 equity, 00400A active equity, 00725B bond, 289 rows total):
// scaling the PCF basket by (outstandingUnits / basketUnit) does NOT reproduce the official actual holdings
// — real per-row differences up to -6.15%, not rounding noise. So this adapter reads positions directly
// from the GetETFDetail* "actual holdings" endpoints and never derives/scales them from the PCF basket.
// GetBuySale (fund-level meta: NAV, outstanding units, and the official `preDateC` holdings date) is still
// used for snapshot-level metadata only, never for position amounts.
//
// Identity model (corrected 2026-09-25, confirmed via the official https://cwapi.cathaysite.com.tw/api/
// ETF/GetETFList?FundType=&PerPageCount=9999&status=1 master list, which itself returns totalCount=41):
// Cathay has 44 market-facing ETF codes but only 41 independent portfolios. 00636K / 00657K / 00668K are
// additional foreign-currency-denominated trading classes ("加掛外幣受益憑證") of 00636 / 00657 / 00668
// respectively — same fund, same holdings, same FundCode — not separate portfolios. Confirmed by: (a) the
// official ETF picker's own search returns zero results for "00636K" etc. as a distinct product, and (b)
// GetLastPCFForeignCurr?FundCode=66 itself reports "etfStock":"00636K" as the foreign-currency share class
// of FundCode 66 (=00636). These 3 are aliased to their base ticker's canonical snapshot, never fetched
// independently.
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BUYSALE_BASE = "https://cwapi.cathaysite.com.tw/api/BuySale";
const ETF_BASE = "https://cwapi.cathaysite.com.tw/api/ETF";

// market ticker (alias) -> base ticker whose canonical snapshot it shares. Provenance: TWSE/Cathay official
// product identity — same FundCode, same holdings, only the trading currency class differs. Never fetched
// on their own; fetchSnapshot() below resolves straight through to the base ticker's snapshot.
export const CATHAY_ALIAS_MAP: Record<string, string> = {
  "00636K": "00636",
  "00657K": "00657",
  "00668K": "00668",
};

// market ticker (independent portfolio) -> official internal FundCode. Captured verbatim from
// https://cwapi.cathaysite.com.tw/api/ETF/GetETFList?FundType=&PerPageCount=9999&status=1 (totalCount=41,
// one-time read 2026-09-25, never guessed). Re-derive from the same endpoint if the issuer adds/removes an
// ETF — do not hand-edit individual entries.
const FUND_CODE_MAP: Record<string, string> = {
  "00400A": "EA", "00636": "66", "00655L": "82", "00656R": "83", "00657": "84",
  "00663L": "87", "00664R": "88", "00668": "93", "00669R": "94", "00687B": "A8",
  "00687C": "DY", "00688L": "A9", "00689R": "AA", "00701": "AD", "00702": "AE",
  "00725B": "AJ", "00726B": "AK", "00727B": "AL", "00735": "AW", "00736": "AU",
  "00737": "AV", "00761B": "BE", "00770": "BH", "00781B": "BJ", "00782B": "BK",
  "00780B": "BI", "00799B": "BQ", "00830": "BO", "00852L": "C2", "00865B": "CB",
  "00875": "CC", "00878": "CN", "00881": "CR", "00893": "CW", "00898": "D6",
  "00909": "DD", "00916": "DF", "00922": "DO", "00933B": "DT", "009817": "E9",
  "00990B": "EB",
};

type BuySaleResult = {
  fundName: string; stockCode: string; aum: string; totUnit: string;
  date: string; preDateC: string; dataDate: string; etfType: string;
};
type BuySaleResponse = { result: BuySaleResult | null; returnCode: string; success: boolean; returnMessage: string };
type ActualStockRow = { stockCode: string; stockName: string; volumn: string; weights: string };
type ActualBondRow = { bondNo: string; bondName: string; parValue: string; ntMkval: string };
type ActualFutureRow = { ftNo: string; ftName: string; volumn: string; ntMkval: string };
type ListResponse<T> = { result: T[] | null; returnCode: string; success: boolean; returnMessage: string };

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(String(s).replace(/[,%]/g, "").trim()) || 0;
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Referer: "https://www.cathaysite.com.tw/ETF/purchase" }, signal });
  if (!r.ok) throw new Error(`CATHAY_HTTP_${r.status}_${url}`);
  return r.json() as Promise<T>;
}

async function fetchBaseSnapshot(baseTicker: string, date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
  const fundCode = FUND_CODE_MAP[baseTicker];
  if (!fundCode) throw new Error(`CATHAY_UNMAPPED_ETF_${baseTicker} — not in the official GetETFList map, never guessed`);
  // GetBuySale resolves "current" itself when SearchDate is omitted (confirmed: omitting it returns the
  // same result as the site's own default page load; passing today's calendar date instead is NOT
  // equivalent — it can return "查無資料" for a date not yet published).
  const buySaleDateParam = date ? `&SearchDate=${date}` : "";
  const buySale = await fetchJson<BuySaleResponse>(`${BUYSALE_BASE}/GetBuySale?FundCode=${fundCode}${buySaleDateParam}&IsTest=false&status=1`, signal);
  if (!buySale.success || !buySale.result) throw new Error(`CATHAY_BUYSALE_FAILED_${baseTicker}_${date ?? "default"} — ${buySale.returnMessage}`);
  const meta = buySale.result;
  // `preDateC` is the official date this holdings composition actually reflects (confirmed via the PCF-vs-
  // actual-holdings validation: both the PCF basket and the GetETFDetail* actual-holdings endpoints agree
  // on this same date). The GetETFDetail* endpoints take it in dash format.
  const holdingsDate = meta.preDateC || meta.date || date;
  if (!holdingsDate) throw new Error(`CATHAY_NO_RESOLVED_DATE_${baseTicker} — GetBuySale returned no date to key the holdings-detail calls on`);
  const detailDate = holdingsDate.replaceAll("/", "-");

  const [stocks, bonds, futures] = await Promise.all([
    fetchJson<ListResponse<ActualStockRow>>(`${ETF_BASE}/GetETFDetailStockList?FundCode=${fundCode}&SearchDate=${detailDate}&status=1`, signal),
    fetchJson<ListResponse<ActualBondRow>>(`${ETF_BASE}/GetETFDetailBondList?FundCode=${fundCode}&SearchDate=${detailDate}&status=1`, signal),
    fetchJson<ListResponse<ActualFutureRow>>(`${ETF_BASE}/GetETFDetailFutureList?FundCode=${fundCode}&SearchDate=${detailDate}&status=1`, signal),
  ]);

  const stockRows = stocks.result ?? [];
  const bondRows = bonds.result ?? [];
  const futureRows = futures.result ?? [];
  if (!stockRows.length && !bondRows.length && !futureRows.length) throw new Error(`CATHAY_NO_HOLDINGS_${baseTicker}_${detailDate}`);

  const positions: CanonicalPosition[] = [
    ...stockRows.map((s) => ({
      securityCode: s.stockCode, securityName: s.stockName,
      positionType: "EQUITY" as const, positionAmount: num(s.volumn), positionUnit: "SHARES" as const,
      weight: num(s.weights), canonicalSecurityId: null,
    })),
    ...bondRows.map((b) => ({
      securityCode: b.bondNo, securityName: b.bondName,
      positionType: "BOND" as const, positionAmount: num(b.parValue), positionUnit: "PAR_VALUE" as const,
      weight: num(b.ntMkval), canonicalSecurityId: null,
    })),
    ...futureRows.map((f) => ({
      securityCode: f.ftNo, securityName: f.ftName,
      positionType: "FUTURE" as const, positionAmount: num(f.volumn), positionUnit: "CONTRACTS" as const,
      weight: num(f.ntMkval), canonicalSecurityId: null,
    })),
  ];

  return {
    etfCode: baseTicker,
    issuer: "Cathay",
    assetType:
      stockRows.length && bondRows.length ? "MULTI_ASSET" :
      bondRows.length ? "BOND" :
      stockRows.length ? "EQUITY" : "OTHER",
    dataDate: detailDate,
    announcementDate: detailDate,
    fundNav: num(meta.aum),
    outstandingUnits: num(meta.totUnit),
    positions,
    source: "CATHAY_OFFICIAL_ACTUAL_HOLDINGS_API",
    retrievedAt: new Date().toISOString(),
  };
}

export const CathayOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "Cathay",

  async fetchSnapshot(etfCode: string, date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const baseTicker = CATHAY_ALIAS_MAP[etfCode] ?? etfCode;
    const snapshot = await fetchBaseSnapshot(baseTicker, date, signal);
    // An alias (K-class) publishes the identical base-fund snapshot under its own market ticker — same
    // holdings, same dates, same figures; only the reported etfCode differs.
    return baseTicker === etfCode ? snapshot : { ...snapshot, etfCode };
  },
};
