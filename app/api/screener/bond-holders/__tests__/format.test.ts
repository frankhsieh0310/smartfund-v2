import assert from "node:assert/strict";

// Mirrors the CUSIP_RE/ISIN_RE validation in ../route.ts (kept inline there, not exported, since
// it's a tiny route-local concern) -- this test guards the exact regex shape independently.
const CUSIP_RE = /^[0-9A-Z]{9}$/;
const ISIN_RE = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("valid CUSIP (9 chars) matches", () => {
  assert.equal(CUSIP_RE.test("3140XREC5"), true);
});
test("valid ISIN (2 letters + 9 + 1 digit = 12 chars) matches", () => {
  assert.equal(ISIN_RE.test("US3132DWBP77"), true);
});
test("a CUSIP is never mistaken for a valid ISIN and vice versa", () => {
  assert.equal(ISIN_RE.test("3140XREC5"), false);
  assert.equal(CUSIP_RE.test("US3132DWBP77"), false);
});
test("garbage input matches neither", () => {
  assert.equal(CUSIP_RE.test("not-a-cusip"), false);
  assert.equal(ISIN_RE.test("not-an-isin"), false);
});
