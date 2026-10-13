import assert from "node:assert/strict";
import { missingForToday, type LastProcessedDateMap } from "../completion.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
  return p;
}

(async () => {
  test("missingForToday: an etf with no lastProcessedDate entry is missing", () => {
    const map: LastProcessedDateMap = {};
    assert.deepEqual(missingForToday(["a", "b"], map, "2026-10-11"), ["a", "b"]);
  });

  test("missingForToday: an etf whose lastProcessedDate equals today is NOT missing", () => {
    const map: LastProcessedDateMap = { a: "2026-10-11" };
    assert.deepEqual(missingForToday(["a", "b"], map, "2026-10-11"), ["b"]);
  });

  test("missingForToday: date alignment to an earlier date (e.g. 10/9) never affects completion — lastProcessedDate records the PROCESSING day, not the aligned write date", () => {
    // This is the exact scenario the user flagged: etf-returns-sync merges onto cloud-etf-price's
    // row at an earlier date (10/9) to preserve return_1d/return_6m, but the completion map must
    // still record "processed on 10/11" (today), not "10/9" (the aligned write date) — otherwise
    // the etf would be judged missing again on every subsequent day and never stop being re-fetched.
    const today = "2026-10-11";
    const alignedWriteDate = "2026-10-09"; // what the actual etf_performances row's `date` column holds
    const map: LastProcessedDateMap = { a: today }; // route.ts sets this to `today`, never to alignedWriteDate
    assert.notEqual(alignedWriteDate, today);
    assert.deepEqual(missingForToday(["a"], map, today), []);
    // and the next day, it correctly becomes missing again (completion is per-calendar-day)
    assert.deepEqual(missingForToday(["a"], map, "2026-10-12"), ["a"]);
  });

  test("missingForToday: a stale lastProcessedDate from a previous day makes the etf missing again today", () => {
    const map: LastProcessedDateMap = { a: "2026-10-10" };
    assert.deepEqual(missingForToday(["a"], map, "2026-10-11"), ["a"]);
  });

  test("missingForToday: empty coreIds returns empty regardless of the map", () => {
    assert.deepEqual(missingForToday([], { a: "2026-10-11" }, "2026-10-11"), []);
  });
})();
