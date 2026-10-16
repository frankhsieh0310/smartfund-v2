import assert from "node:assert/strict";
import { checkPipelineRunLog, evaluateFreshness, checkEtfDataSourceGap, evaluateYahooTwReturnConsistency, type QueryFn } from "../checks.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
  return p;
}

(async () => {
  test("checkPipelineRunLog: no runs in 24h -> anomaly NO_RUN_IN_LAST_24H", async () => {
    const query: QueryFn = async () => [];
    const r = await checkPipelineRunLog(query, "SOME_JOB");
    assert.equal(r.anomaly, true);
    assert.ok(r.anomalyReasons.includes("NO_RUN_IN_LAST_24H"));
  });

  test("checkPipelineRunLog: clean runs -> no anomaly", async () => {
    const query: QueryFn = async () => [
      { status: "COMPLETED", error: null, write_error_count: "0", started_at: new Date() },
      { status: "COMPLETED", error: null, write_error_count: "0", started_at: new Date() },
    ];
    const r = await checkPipelineRunLog(query, "SOME_JOB");
    assert.equal(r.anomaly, false);
    assert.equal(r.hasRunInLast24h, true);
  });

  test("checkPipelineRunLog: one run with error -> anomaly", async () => {
    const query: QueryFn = async () => [
      { status: "FAILED", error: "boom", write_error_count: "0", started_at: new Date() },
    ];
    const r = await checkPipelineRunLog(query, "SOME_JOB");
    assert.equal(r.anomaly, true);
    assert.equal(r.errorCount24h, 1);
  });

  test("checkPipelineRunLog: write_error_count > 0 -> anomaly even if error is null", async () => {
    const query: QueryFn = async () => [
      { status: "COMPLETED", error: null, write_error_count: "5", started_at: new Date() },
    ];
    const r = await checkPipelineRunLog(query, "SOME_JOB");
    assert.equal(r.anomaly, true);
    assert.equal(r.writeErrorCount24h, 5);
  });

  test("evaluateFreshness: no data -> anomaly NO_DATA", () => {
    const r = evaluateFreshness("test", null, 3);
    assert.equal(r.anomaly, true);
    assert.equal(r.anomalyReason, "NO_DATA");
  });

  test("evaluateFreshness: within threshold -> no anomaly", () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const r = evaluateFreshness("test", yesterday, 3);
    assert.equal(r.anomaly, false);
  });

  test("evaluateFreshness: beyond threshold -> anomaly", () => {
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const r = evaluateFreshness("test", old, 3);
    assert.equal(r.anomaly, true);
    assert.ok(r.anomalyReason?.startsWith("STALE_"));
  });

  test("checkEtfDataSourceGap: no NULL rows -> no anomaly", async () => {
    const query: QueryFn = async () => [];
    const r = await checkEtfDataSourceGap(query);
    assert.equal(r.anomaly, false);
    assert.equal(r.nullCount, 0);
  });

  test("checkEtfDataSourceGap: only the known gap (00838B) -> NOT an anomaly", async () => {
    const query: QueryFn = async () => [{ code: "00838B" }];
    const r = await checkEtfDataSourceGap(query);
    assert.equal(r.anomaly, false);
    assert.deepEqual(r.knownCodes, ["00838B"]);
    assert.deepEqual(r.newCodes, []);
  });

  test("checkEtfDataSourceGap: a new, undocumented gap alongside the known one -> anomaly, known code excluded from newCodes", async () => {
    const query: QueryFn = async () => [{ code: "00838B" }, { code: "00999Z" }];
    const r = await checkEtfDataSourceGap(query);
    assert.equal(r.anomaly, true);
    assert.deepEqual(r.newCodes, ["00999Z"]);
    assert.deepEqual(r.knownCodes, ["00838B"]);
    assert.equal(r.nullCount, 2);
  });

  test("checkEtfDataSourceGap: codes list caps at 10 for display, but nullCount reflects the true total", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ code: `0${1000 + i}X` }));
    const query: QueryFn = async () => rows;
    const r = await checkEtfDataSourceGap(query);
    assert.equal(r.nullCount, 15);
    assert.equal(r.codes.length, 10);
    assert.equal(r.newCodes.length, 15);
    assert.equal(r.anomaly, true);
  });

  test("evaluateYahooTwReturnConsistency: a small drift (within threshold) is not an anomaly", async () => {
    const r = evaluateYahooTwReturnConsistency([
      { code: "0050", ourReturn1y: 98.71, yahooTwReturn1y: 89.64, fetchFailed: false, ourBasisDate: "2026-10-15", yahooAsOfDate: "2026-10-15" },
    ]);
    assert.equal(r.anomaly, false);
    assert.equal(r.mismatches.length, 0);
  });

  test("evaluateYahooTwReturnConsistency: a drift beyond the threshold, SAME basis date, IS an anomaly", async () => {
    const r = evaluateYahooTwReturnConsistency([
      { code: "006208", ourReturn1y: 108.44, yahooTwReturn1y: 89.8, fetchFailed: false, ourBasisDate: "2026-10-15", yahooAsOfDate: "2026-10-15" },
    ]);
    assert.equal(r.anomaly, true);
    assert.equal(r.mismatches.length, 1);
    assert.ok(r.mismatches[0]!.diff! > 15);
  });

  // 2026-10-16: 00980A flagged a 16.46pp "mismatch" at the daily-health-report's 00:30 UTC run
  // purely because etf-returns-sync hadn't refreshed it yet that day -- our stored value was still
  // yesterday's basis date while Yahoo奇摩's own page already disclosed today's. Verified the figures
  // matched exactly (90.94 both sides) once etf-returns-sync's own run caught up hours later. A
  // mismatch between different basis dates, below the hard ceiling, must not be flagged.
  test("evaluateYahooTwReturnConsistency: a drift beyond the threshold but DIFFERENT basis date is staleness, not an anomaly", async () => {
    const r = evaluateYahooTwReturnConsistency([
      { code: "00980A", ourReturn1y: 107.4, yahooTwReturn1y: 90.94, fetchFailed: false, ourBasisDate: "2026-10-11", yahooAsOfDate: "2026-10-15" },
    ]);
    assert.equal(r.anomaly, false);
    assert.equal(r.mismatches.length, 0);
  });

  test("evaluateYahooTwReturnConsistency: a drift beyond the hard ceiling is ALWAYS an anomaly, even with different basis dates", async () => {
    const r = evaluateYahooTwReturnConsistency([
      { code: "00980A", ourReturn1y: 150, yahooTwReturn1y: 90.94, fetchFailed: false, ourBasisDate: "2026-10-11", yahooAsOfDate: "2026-10-15" },
    ]);
    assert.equal(r.anomaly, true);
    assert.equal(r.mismatches.length, 1);
  });

  test("evaluateYahooTwReturnConsistency: a failed fetch is always an anomaly regardless of diff", async () => {
    const r = evaluateYahooTwReturnConsistency([
      { code: "0056", ourReturn1y: 69.38, yahooTwReturn1y: null, fetchFailed: true, ourBasisDate: "2026-10-15", yahooAsOfDate: null },
    ]);
    assert.equal(r.anomaly, true);
  });

  test("evaluateYahooTwReturnConsistency: all samples clean -> no anomaly", async () => {
    const r = evaluateYahooTwReturnConsistency([
      { code: "0050", ourReturn1y: 98.71, yahooTwReturn1y: 89.64, fetchFailed: false, ourBasisDate: "2026-10-15", yahooAsOfDate: "2026-10-15" },
      { code: "0056", ourReturn1y: 69.38, yahooTwReturn1y: 72.07, fetchFailed: false, ourBasisDate: "2026-10-15", yahooAsOfDate: "2026-10-15" },
    ]);
    assert.equal(r.anomaly, false);
  });
})();
