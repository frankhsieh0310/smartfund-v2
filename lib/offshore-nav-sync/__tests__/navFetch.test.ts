import assert from "node:assert/strict";

// Regression test: Yahoo's fundsPriceHistory returns closePrices/dates as arrays of STRINGS
// (e.g. "27.94"), not numbers. Number.isFinite() does not coerce strings, so a naive validation
// against the raw string silently rejected every real fund as "no data" -- caught live.
function parseClose(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("parseClose: string '27.94' parses to number 27.94 (the real API shape)", () => {
  assert.equal(parseClose("27.94"), 27.94);
});
test("parseClose: Number.isFinite alone on a string would have rejected this (regression guard)", () => {
  assert.equal(Number.isFinite("27.94" as any), false);
  assert.equal(Number.isFinite(Number("27.94")), true);
});
test("parseClose: non-numeric string -> null", () => {
  assert.equal(parseClose("N/A"), null);
});
test("parseClose: zero/negative -> null", () => {
  assert.equal(parseClose("0"), null);
  assert.equal(parseClose("-1.5"), null);
});
