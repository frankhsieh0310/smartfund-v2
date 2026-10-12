import assert from "node:assert/strict";
import { checkPipelineRunLog, evaluateFreshness, type QueryFn } from "../checks.ts";

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
})();
