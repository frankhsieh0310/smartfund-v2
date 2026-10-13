import assert from "node:assert/strict";
import { toIsoDate, toPercent } from "../fetchClear.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("toIsoDate: fundclear's 2026/10/08 slash format -> 2026-10-08", () => {
  assert.equal(toIsoDate("2026/10/08"), "2026-10-08");
});
test("toIsoDate: null/undefined -> null", () => {
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate(undefined), null);
});
test("toIsoDate: malformed string -> null (never a silently-wrong date)", () => {
  assert.equal(toIsoDate("not-a-date"), null);
});
test("toPercent: '80.00%' -> 80", () => {
  assert.equal(toPercent("80.00%"), 80);
});
test("toPercent: null -> null", () => {
  assert.equal(toPercent(null), null);
});
