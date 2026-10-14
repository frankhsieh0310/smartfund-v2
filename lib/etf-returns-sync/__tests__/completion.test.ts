import assert from "node:assert/strict";
import { missingForToday, type LastProcessedDateMap, type LastProcessedVersionMap } from "../completion.ts";

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

  // Task X7: version-aware reprocessing — a mid-day deploy must not leave already-processed etfs
  // stuck on a pre-fix value until tomorrow.
  test("missingForToday: same date + same version is NOT missing (no currentVersion arg = old behavior)", () => {
    const dateMap: LastProcessedDateMap = { a: "2026-10-14" };
    assert.deepEqual(missingForToday(["a"], dateMap, "2026-10-14"), []);
  });

  test("missingForToday: same date but a DIFFERENT deployment version forces reprocessing today", () => {
    const dateMap: LastProcessedDateMap = { a: "2026-10-14" };
    const versionMap: LastProcessedVersionMap = { a: "dpl_OLD" };
    assert.deepEqual(missingForToday(["a"], dateMap, "2026-10-14", versionMap, "dpl_NEW"), ["a"]);
  });

  test("missingForToday: same date AND same deployment version is not reprocessed", () => {
    const dateMap: LastProcessedDateMap = { a: "2026-10-14" };
    const versionMap: LastProcessedVersionMap = { a: "dpl_NEW" };
    assert.deepEqual(missingForToday(["a"], dateMap, "2026-10-14", versionMap, "dpl_NEW"), []);
  });

  test("missingForToday: an etf with no recorded version at all is reprocessed once a currentVersion is known", () => {
    const dateMap: LastProcessedDateMap = { a: "2026-10-14" };
    const versionMap: LastProcessedVersionMap = {}; // e.g. written before this fix shipped
    assert.deepEqual(missingForToday(["a"], dateMap, "2026-10-14", versionMap, "dpl_NEW"), ["a"]);
  });

  test("missingForToday: currentVersion=null (no VERCEL_DEPLOYMENT_ID, e.g. local dev) skips the version check entirely", () => {
    const dateMap: LastProcessedDateMap = { a: "2026-10-14" };
    const versionMap: LastProcessedVersionMap = {}; // would force reprocessing if version check ran
    assert.deepEqual(missingForToday(["a"], dateMap, "2026-10-14", versionMap, null), []);
  });
})();
