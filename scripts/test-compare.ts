import assert from "node:assert/strict";
import { pairOverlap, parseCompareRefs } from "../lib/holdings/compareService";

assert.deepEqual(parseCompareRefs("ETF:a,FUND:b"), [{ kind: "ETF", id: "a" }, { kind: "FUND", id: "b" }]);
assert.deepEqual(parseCompareRefs("ETF:a,ETF:a,FUND:b"), [{ kind: "ETF", id: "a" }, { kind: "FUND", id: "b" }]);
assert.ok("error" in (parseCompareRefs("ETF:a") as object));
assert.ok("error" in (parseCompareRefs("ETF:a,ETF:b,ETF:c,ETF:d,ETF:e") as object));
assert.ok("error" in (parseCompareRefs("STOCK:a,ETF:b") as object));

const A = { productId: "A", asOfDate: "d", holdings: [{ key: "2330", name: "台積電", weightPct: 50 }, { key: "2317", name: "鴻海", weightPct: 10 }] };
const B = { productId: "B", asOfDate: "d", holdings: [{ key: "x1", name: "台積電", weightPct: 30 }, { key: "x2", name: "台積電", weightPct: 5 }, { key: "x3", name: "聯發科", weightPct: 20 }] };
const o = pairOverlap(A, B);
assert.equal(o.sharedCount, 1); // duplicate names inside B merge; B never overlaps itself
assert.equal(o.overlapWeightPct, 35); // min(50, 30+5)
assert.equal(pairOverlap(A, { productId: "C", asOfDate: null, holdings: [{ key: "k", name: "Apple", weightPct: 5 }] }).sharedCount, 0);
console.log("compare tests passed");
