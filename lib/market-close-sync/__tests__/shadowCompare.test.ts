import assert from "node:assert/strict";
import { classify } from "../shadowCompare.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("NEW: DB has no row at all", () => {
  assert.equal(classify({ dbDate: null, dbClose: null, sparkDate: "2026-10-08", sparkClose: 100 }), "NEW");
});

test("SOURCE_MISSING: Spark had nothing for the target date (pickClosedCandle returned null)", () => {
  assert.equal(classify({ dbDate: "2026-10-07", dbClose: 100, sparkDate: null, sparkClose: null }), "SOURCE_MISSING");
});

test("SAME: identical date and close", () => {
  assert.equal(classify({ dbDate: "2026-10-08", dbClose: 100.5, sparkDate: "2026-10-08", sparkClose: 100.5 }), "SAME");
});

test("CHANGED: same date, different close", () => {
  assert.equal(classify({ dbDate: "2026-10-08", dbClose: 100.5, sparkDate: "2026-10-08", sparkClose: 101.0 }), "CHANGED");
});

test("CHANGED: DB older date, Spark has a newer close (the real catch-up case)", () => {
  assert.equal(classify({ dbDate: "2026-10-07", dbClose: 99.0, sparkDate: "2026-10-08", sparkClose: 100.5 }), "CHANGED");
});

test("DB_NEWER: DB's date is already ahead of Spark's target date — never regress it", () => {
  assert.equal(classify({ dbDate: "2026-10-09", dbClose: 100.5, sparkDate: "2026-10-08", sparkClose: 99.0 }), "DB_NEWER");
});

console.log("SHADOW_COMPARE_TESTS_DONE");
