import assert from "node:assert/strict";
import { analyzePortfolio, computeWeights, parsePortfolioParams, type LoadedProduct } from "../lib/holdings/portfolioAnalysis";

const row = (name: string, weightPct: number, sector: string | null = null, country: string | null = null, ticker: string | null = null) => ({ key: name, name, weightPct, sector, country, ticker });
const prod = (ref: string, weightPct: number, rows: ReturnType<typeof row>[], depth: LoadedProduct["coverageDepth"] = "FULL"): LoadedProduct => ({
  ref, kind: "ETF", id: ref, name: ref, code: ref, found: true, weightPct, rows, coverageDepth: depth, isFullHoldings: depth === "FULL",
  presentRowCount: rows.length, declaredCount: null, asOfDate: "d", source: "s",
});

// parsing / limits
assert.ok("error" in parsePortfolioParams("ETF:a:1", "X"));
assert.ok("error" in parsePortfolioParams("ETF:a:0", "AMOUNT"));
assert.ok("error" in parsePortfolioParams(Array.from({ length: 11 }, (_, i) => `ETF:a${i}:1`).join(","), "AMOUNT"));
assert.ok(!("error" in parsePortfolioParams(Array.from({ length: 10 }, (_, i) => `ETF:a${i}:1`).join(","), "AMOUNT")));

// amount mode -> weights; weight mode -> given, warned if != 100, never rescaled
const amt = computeWeights([{ kind: "ETF", id: "a", value: 300000 }, { kind: "ETF", id: "b", value: 100000 }], "AMOUNT");
assert.deepEqual(amt.weights, [75, 25]);
assert.equal(amt.weightSumOk, true);
const w = computeWeights([{ kind: "ETF", id: "a", value: 60 }, { kind: "ETF", id: "b", value: 30 }], "WEIGHT");
assert.deepEqual(w.weights, [60, 30]);
assert.equal(w.weightSumOk, false);
assert.ok(w.weightWarning);

// look-through: TSMC 50% in A(60% of pf) and 20% in B(40% of pf) -> 30 + 8 = 38; held by 2
const A = prod("A", 60, [row("台積電", 50, "半導體", "TW", "2330"), row("鴻海", 10, null, "TW")]);
const B = prod("B", 40, [row("台積電", 20, "半導體", "TW"), row("Apple Inc", 30, null, "US")], "PARTIAL");
const empty = prod("C", 0, []);
const r = analyzePortfolio([A, B, empty], "WEIGHT", { totalWeightPct: 100, totalAmount: null, weightSumOk: true, weightWarning: null });
const tsmc = r.stockExposure.top10[0];
assert.equal(tsmc.name, "台積電");
assert.equal(tsmc.exposurePct, 38);
assert.equal(tsmc.holderCount, 2);
assert.equal(tsmc.ticker, "2330");
assert.deepEqual(tsmc.contributions.map((c) => [c.label, c.contributionPct]), [["A", 30], ["B", 8]]);
assert.equal(r.duplicates.count, 1);
assert.equal(r.duplicates.exposurePct, 38);
assert.equal(r.sector.largest?.label, "半導體");
assert.equal(r.sector.largest?.exposurePct, 38); // 60%*50 + 40%*20
assert.equal(r.country.all.find((c) => c.label === "TW")?.exposurePct, 44); // A: 60%*(50+10) + B: 40%*20
// incompleteness + exclusion are reported, not hidden
assert.equal(r.completeness.isPartialAnalysis, true);
assert.deepEqual(r.completeness.incompleteProducts.map((p) => p.label), ["B"]);
assert.deepEqual(r.completeness.excludedProducts.map((p) => p.label), ["C"]);
assert.match(r.completeness.basisNote, /依目前可取得持股估算/);
// nothing invented for sector when none classified
const noSector = analyzePortfolio([prod("D", 100, [row("X", 5)])], "WEIGHT", { totalWeightPct: 100, totalAmount: null, weightSumOk: true, weightWarning: null });
assert.equal(noSector.sector.hasClassifiedData, false);
assert.equal(noSector.sector.largest, null);
console.log("portfolio-analysis tests passed");
