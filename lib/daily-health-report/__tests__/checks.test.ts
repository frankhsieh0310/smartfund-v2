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

  // 2026-10-21: VERIFIED live case -- CLOUD_ETF_PRICE's 01:17 run failed one symbol, but the next
  // (02:17) run was clean and the symbol already had fresh data. A later clean run is evidence the
  // pipeline already self-healed; only an unresolved streak at the top (newest-first) should count.
  test("checkPipelineRunLog: an older error followed by a newer clean run -> self-healed, no anomaly", async () => {
    const query: QueryFn = async () => [
      { status: "PARTIAL", error: null, write_error_count: "0", started_at: new Date() }, // newest
      { status: "PARTIAL", error: "1 failures; e.g. YAHOO_CHART_NULL", write_error_count: "0", started_at: new Date(Date.now() - 3600_000) },
    ];
    const r = await checkPipelineRunLog(query, "SOME_JOB");
    assert.equal(r.errorCount24h, 0);
  });

  test("checkPipelineRunLog: the newest run itself still has an error -> still unresolved", async () => {
    const query: QueryFn = async () => [
      { status: "PARTIAL", error: "1 failures; e.g. YAHOO_CHART_NULL", write_error_count: "0", started_at: new Date() }, // newest
      { status: "PARTIAL", error: null, write_error_count: "0", started_at: new Date(Date.now() - 3600_000) },
    ];
    const r = await checkPipelineRunLog(query, "SOME_JOB");
    assert.equal(r.errorCount24h, 1);
    assert.equal(r.anomaly, true);
  });

  // 2026-10-21: VERIFIED live -- CLOUD_SEC_FINANCIAL_INCREMENTAL's route now reports status
  // COMPLETED when every failure is the permanent SEC_NO_CANONICAL_FACTS case (fixed in that route
  // itself), but this BENIGN_ERROR_PATTERNS entry is defense in depth for an older run's error field.
  test("checkPipelineRunLog: CLOUD_SEC_FINANCIAL_INCREMENTAL's permanent SEC_NO_CANONICAL_FACTS is benign, not an error", async () => {
    const query: QueryFn = async () => [
      { status: "COMPLETED", error: '[{"cik":"0002039972","reason":"SEC_NO_CANONICAL_FACTS"}]', write_error_count: "0", started_at: new Date() },
    ];
    const r = await checkPipelineRunLog(query, "CLOUD_SEC_FINANCIAL_INCREMENTAL");
    assert.equal(r.errorCount24h, 0);
    assert.equal(r.sourceUnavailableCount24h, 1);
    assert.equal(r.anomaly, false);
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
      { code: "0050", ourReturn1y: 98.71, yahooTwReturn1y: 89.64, fetchFailed: false },
    ]);
    assert.equal(r.anomaly, false);
    assert.equal(r.mismatches.length, 0);
  });

  test("evaluateYahooTwReturnConsistency: a drift beyond the threshold IS an anomaly", async () => {
    const r = evaluateYahooTwReturnConsistency([
      { code: "006208", ourReturn1y: 108.44, yahooTwReturn1y: 89.8, fetchFailed: false },
    ]);
    assert.equal(r.anomaly, true);
    assert.equal(r.mismatches.length, 1);
    assert.ok(r.mismatches[0]!.diff! > 15);
  });

  test("evaluateYahooTwReturnConsistency: a failed fetch is always an anomaly regardless of diff", async () => {
    const r = evaluateYahooTwReturnConsistency([
      { code: "0056", ourReturn1y: 69.38, yahooTwReturn1y: null, fetchFailed: true },
    ]);
    assert.equal(r.anomaly, true);
  });

  // 2026-10-21: VERIFIED live case -- 00990B (listed 2026-06-29, under 4 months old) has ourReturn1y
  // AND yahooTwReturn1y both null, and both sides agreeing there's no 1-year return yet is NOT a
  // mismatch. Only a one-sided null (we have a value and Yahoo doesn't, or vice versa) is a real
  // disagreement worth flagging.
  test("evaluateYahooTwReturnConsistency: both sides null (too new for a 1y return) -> no anomaly", () => {
    const r = evaluateYahooTwReturnConsistency([{ code: "00990B", ourReturn1y: null, yahooTwReturn1y: null, fetchFailed: false }]);
    assert.equal(r.anomaly, false);
  });

  test("evaluateYahooTwReturnConsistency: one side null, other has a value -> anomaly", () => {
    const r = evaluateYahooTwReturnConsistency([{ code: "0099X", ourReturn1y: 12.3, yahooTwReturn1y: null, fetchFailed: false }]);
    assert.equal(r.anomaly, true);
  });

  test("evaluateYahooTwReturnConsistency: all samples clean -> no anomaly", async () => {
    const r = evaluateYahooTwReturnConsistency([
      { code: "0050", ourReturn1y: 98.71, yahooTwReturn1y: 89.64, fetchFailed: false },
      { code: "0056", ourReturn1y: 69.38, yahooTwReturn1y: 72.07, fetchFailed: false },
    ]);
    assert.equal(r.anomaly, false);
  });
})();
