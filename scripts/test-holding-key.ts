import assert from "node:assert/strict";
import { canonicalHoldingKey, mergeByCanonicalKey, normalizeHoldingName } from "../lib/holdings/holdingKey";
import { assessDiffComparability, applyComparability } from "../lib/holdings/diffComparability";
import { diffHoldingsSnapshots } from "../lib/holdings/holdingsAnalysis";

const same: Array<[string, string]> = [
  ["TransDigm", "TransDigm, Inc. 7.125%"],
  ["United Airlines Holdings", "United Airlines Holdings Inc 5.375%"],
  ["DISH DBS", "DISH DBS Corporation 5.125%"],
  ["Carrix", "Carrix Inc. 6.125%"],
  ["American Axle & Manufacturing", "American Axle & Manufacturing, Inc. 7.75%"],
];
for (const [a, b] of same) assert.equal(normalizeHoldingName(a), normalizeHoldingName(b), `${a} ~ ${b}`);
assert.notEqual(normalizeHoldingName("Vodafone Group"), normalizeHoldingName("Venture Global LNG"));
assert.notEqual(normalizeHoldingName("FMC Corp. 8%"), normalizeHoldingName("EZCORP Inc. 7.375%"));
assert.equal(canonicalHoldingKey("US123", "TransDigm"), "US123"); // id keys untouched
const merged = mergeByCanonicalKey([
  { key: "Acme Inc 5%", name: "Acme Inc 5%", weightPct: 1 },
  { key: "Acme Corp 6%", name: "Acme Corp 6%", weightPct: 0.5 },
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].weightPct, 1.5);

// end-to-end: mismatched spellings become shared keys; unmatched stay non-definitive under CONSERVATIVE
const prev = mergeByCanonicalKey([{ key: "TransDigm", name: "TransDigm", weightPct: 2 }, { key: "Vodafone Group", name: "Vodafone Group", weightPct: 1 }]);
const next = mergeByCanonicalKey([{ key: "TransDigm, Inc. 7.125%", name: "TransDigm, Inc. 7.125%", weightPct: 1 }, { key: "FMC Corp. 8%", name: "FMC Corp. 8%", weightPct: 0.85 }]);
const cmp = assessDiffComparability(
  { date: "1", source: "A", coverageDepth: "TOP_N", presentRowCount: 2, declaredCount: null },
  { date: "2", source: "B", coverageDepth: "TOP_N", presentRowCount: 2, declaredCount: null },
);
const r = applyComparability(diffHoldingsSnapshots(prev, next), cmp);
assert.deepEqual(r.entries.map((e) => e.change), ["DECREASED"]);
assert.equal(r.newlyDisclosed.length, 1);
assert.equal(r.noLongerDisclosed.length, 1);
console.log("holding-key tests passed");
