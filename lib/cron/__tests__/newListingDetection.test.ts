import assert from "node:assert/strict";
import { parseRocDate } from "../newListingDetection.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("ROC date '1150826' -> 2026-08-26", () => {
  const d = parseRocDate("1150826");
  assert.ok(d);
  assert.equal(d!.toISOString().slice(0, 10), "2026-08-26");
});

test("quoted ROC date '\"1151014\"' -> 2026-10-14", () => {
  const d = parseRocDate('"1151014"');
  assert.ok(d);
  assert.equal(d!.toISOString().slice(0, 10), "2026-10-14");
});

test("blank/empty -> null", () => {
  assert.equal(parseRocDate(""), null);
  assert.equal(parseRocDate(undefined), null);
});

test("garbage -> null, never throws", () => {
  assert.equal(parseRocDate("不適用"), null);
  assert.equal(parseRocDate("abc"), null);
});

test("7-digit ROC date (3-digit year) parses correctly", () => {
  const d = parseRocDate("1000112"); // ROC 100 = AD 2011
  assert.ok(d);
  assert.equal(d!.toISOString().slice(0, 10), "2011-01-12");
});
