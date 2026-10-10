import assert from "node:assert/strict";
import { classify } from "../shadowCompare.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("NEW: DB has no row at all", () => {
  assert.equal(classify({ dbDate: null, dbClose: null, sparkSymbolPresent: true, sparkDate: "2026-10-08", sparkClose: 100 }), "NEW");
});

test("SOURCE_MISSING: Spark's result array had no entry at all for this symbol", () => {
  assert.equal(classify({ dbDate: "2026-10-07", dbClose: 100, sparkSymbolPresent: false, sparkDate: null, sparkClose: null }), "SOURCE_MISSING");
});

test("NO_BAR_FOR_TARGET_DATE: Spark had the symbol (real candles exist) but none landed on the target date — must NOT be collapsed into SOURCE_MISSING", () => {
  assert.equal(classify({ dbDate: "2026-10-07", dbClose: 100, sparkSymbolPresent: true, sparkDate: null, sparkClose: null }), "NO_BAR_FOR_TARGET_DATE");
});

test("SAME: identical date and close", () => {
  assert.equal(classify({ dbDate: "2026-10-08", dbClose: 100.5, sparkSymbolPresent: true, sparkDate: "2026-10-08", sparkClose: 100.5 }), "SAME");
});

test("CHANGED: same date, different close", () => {
  assert.equal(classify({ dbDate: "2026-10-08", dbClose: 100.5, sparkSymbolPresent: true, sparkDate: "2026-10-08", sparkClose: 101.0 }), "CHANGED");
});

test("CHANGED: DB older date, Spark has a newer close (the real catch-up case)", () => {
  assert.equal(classify({ dbDate: "2026-10-07", dbClose: 99.0, sparkSymbolPresent: true, sparkDate: "2026-10-08", sparkClose: 100.5 }), "CHANGED");
});

test("DB_NEWER: DB's date is already ahead of Spark's target date — never regress it", () => {
  assert.equal(classify({ dbDate: "2026-10-09", dbClose: 100.5, sparkSymbolPresent: true, sparkDate: "2026-10-08", sparkClose: 99.0 }), "DB_NEWER");
});

console.log("SHADOW_COMPARE_TESTS_DONE");
