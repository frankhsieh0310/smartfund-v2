// Focused, offline tests (no DB, no network) for the Release Data P0 logic.
// Run: npx tsx scripts/test-release-data-p0.ts
import { groupSectorRows } from "../lib/holdings/sectorAllocation";
import { analyzePortfolio, computeWeights, type LoadedProduct } from "../lib/holdings/portfolioAnalysis";
import { parseChartDividends, planDividendCatchUp, DIST_OVERLAP_DAYS } from "../lib/yahoo/distributionFetch";
import { parseTpexNotice, parseTwseNotice, rocToIso, yahooSymbolFor } from "../lib/yahoo/twEtfDistribution";

let failures = 0;
const check = (cond: unknown, msg: string) => {
  if (!cond) { failures++; console.log("FAIL:", msg); } else console.log("ok:", msg);
};
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

// ---- sector allocation grouping: fractions -> percent, zero weights dropped, all-zero ETF absent
const alloc = groupSectorRows([
  { etf_id: "A", observation_date: "2026-09-11", sector_name: "technology", weight: 0.65, source: "YAHOO_QUOTE_SUMMARY" },
  { etf_id: "A", observation_date: "2026-09-11", sector_name: "financial_services", weight: 0.35, source: "YAHOO_QUOTE_SUMMARY" },
  { etf_id: "A", observation_date: "2026-09-11", sector_name: "energy", weight: 0, source: "YAHOO_QUOTE_SUMMARY" },
  { etf_id: "Z", observation_date: "2026-09-11", sector_name: "technology", weight: 0, source: "YAHOO_QUOTE_SUMMARY" },
]);
check(alloc.has("A") && !alloc.has("Z"), "all-zero snapshot => no sector data");
check(near(alloc.get("A")!.coveredPct, 100), "covered pct = sum of buckets");

// ---- portfolio: sector = portfolio weight x ETF sector allocation; uncovered ETFs / funds are not guessed
const prod = (ref: string, kind: "ETF" | "FUND", weightPct: number): LoadedProduct => ({
  ref, kind, id: ref.split(":")[1], name: ref, code: ref.split(":")[1], found: true, weightPct,
  rows: [{ key: "k" + ref, name: "S" + ref, weightPct: 50, ticker: null, sector: null, country: "TW" } as any],
  coverageDepth: "PARTIAL" as any, isFullHoldings: false, presentRowCount: 1, declaredCount: null, asOfDate: "2026-09-18", source: "T",
});
const items = [{ kind: "ETF" as const, id: "A", value: 60 }, { kind: "ETF" as const, id: "B", value: 30 }, { kind: "FUND" as const, id: "F", value: 10 }];
const { weights, ...winfo } = computeWeights(items, "WEIGHT");
const products = [prod("ETF:A", "ETF", weights[0]), prod("ETF:B", "ETF", weights[1]), prod("FUND:F", "FUND", weights[2])];
const res = analyzePortfolio(products, "WEIGHT", winfo, new Map([["ETF:A", alloc.get("A")!]])) as any;
const tech = res.sector.all.find((b: any) => b.key === "technology");
check(near(tech.exposurePct, 39), "60% x 65% = 39% technology");
check(near(res.sector.calculatedPct, 60), "calculated = only the covered ETF's weight");
check(near(res.sector.uncoveredPct, 40), "uncovered = ETF without allocation + fund");
check(res.sector.sourceCoverage.find((c: any) => c.ref === "ETF:B").status === "NO_SECTOR_ALLOCATION", "ETF without allocation is listed uncovered");
check(res.sector.sourceCoverage.find((c: any) => c.ref === "FUND:F").status === "FUND_SECTOR_UNAVAILABLE", "fund sector unavailable");
check(!res.sector.all.some((b: any) => /other|unclassified|未分類/i.test(b.key + b.label)), "no invented Other/Unclassified bucket");
check(near(res.country.calculatedPct, 50), "country = only holdings with a real country (3 products x 50% row)");
// two ETFs with the same sector are summed
const alloc2 = groupSectorRows([{ etf_id: "B", observation_date: "2026-09-11", sector_name: "technology", weight: 1, source: "S" }]);
const res2 = analyzePortfolio(products, "WEIGHT", winfo, new Map([["ETF:A", alloc.get("A")!], ["ETF:B", alloc2.get("B")!]])) as any;
check(near(res2.sector.all.find((b: any) => b.key === "technology").exposurePct, 39 + 30), "same sector across ETFs is summed");
check(res2.stockExposure.distinctStocks === 3 && res2.duplicates.count === 0, "look-through / duplicates unaffected by sector data");

// ---- Yahoo outcome classification + TW notices
check(parseChartDividends("X", 404, { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }).kind === "NOT_AVAILABLE", "404 => NOT_AVAILABLE (terminal)");
check(parseChartDividends("X", 429, null).kind === "FAILED" && parseChartDividends("X", 502, null).kind === "FAILED", "429/5xx => FAILED (retry)");
const empty = parseChartDividends("X", 200, { chart: { result: [{ meta: { currency: "TWD" } }] } });
check(empty.kind === "OK" && empty.events.length === 0, "200 without dividends => EMPTY");
check(rocToIso("115年09月21日") === "2026-09-21" && rocToIso("115/09/16") === "2026-09-16" && rocToIso("1150909") === "2026-09-09" && rocToIso("x") === null, "ROC dates");
check(yahooSymbolFor({ code: "006208", data_source: "006208", exchange: "TWSE" }) === "006208.TW" && yahooSymbolFor({ code: "00687B", data_source: null, exchange: "TPEx" }) === "00687B.TWO", "yahoo symbol from metadata");
const twse = parseTwseNotice({ data: [["115年09月21日", "00713", "x", "息", "0", "0", "0", "1.25000000"], ["115年10月08日", "00400A", "x", "息", "0", "0", "0", "<p>待公告實際收益分配金額</p>"], ["115年09月21日", "2330", "x", "權", "0", "0", "0", "0"]] });
check(twse.length === 1 && twse[0].code === "00713" && twse[0].cashDividend === 1.25, "TWSE notice: announced cash amounts only (no 待公告, no 權-only)");
const tpex = parseTpexNotice({ tables: [{ data: [["115/09/21", "00697B", "x", "除息", "0", "0", "0", "0.31000000"]] }] });
check(tpex.length === 1 && tpex[0].exDate === "2026-09-21", "TPEx notice parsed");

// ---- P3: dividend incremental anchor = last STORED event (never the price-history date)
const epoch = (d: string) => Math.floor(Date.parse(d) / 1000);
check(planDividendCatchUp(null, epoch("2026-09-14")) === null, "no stored event => no catch-up (historical scan belongs to the backfill)");
check(planDividendCatchUp("2026-08-03", epoch("2026-09-14")) === epoch("2026-08-03") - DIST_OVERLAP_DAYS * 86400, "AGG case: price window starts 09-14, last event 08-03 => fetch from event - 45d (finds 09-01)");
check(planDividendCatchUp("2026-08-03", epoch("2026-06-01")) === null, "price window already reaches the anchor => no extra request");
check(DIST_OVERLAP_DAYS === 45, "overlap is 45 days");
const weekly = parseChartDividends("W", 200, { chart: { result: [{ meta: { currency: "USD" }, events: { dividends: { a: { date: 1785000000, amount: 0.1 }, b: { date: 1785604800, amount: 0.1 }, c: { date: 1786209600, amount: 0.1 } } } }] } });
check(weekly.kind === "OK" && weekly.events.length === 3, "weekly payer keeps every event (daily candles)");

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nALL PASSED");
