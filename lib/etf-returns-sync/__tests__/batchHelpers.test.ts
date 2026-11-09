import assert from "node:assert/strict";
import {
  resolveWriteDatesBatch, fetchLatestReturn6mBatch, writeEtfsRankingColumnsBatch, type EtfsRankingEntry, type QueryFn,
  fetchLatestLongPeriodReturnsBatch, isImplausibleReturnJump, longPeriodReturnsLookImplausible,
} from "../batchHelpers.ts";
import type { TrailingReturns } from "../types.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
  return p;
}

function mockQuery(impl?: (sql: string, params: any[]) => any[]): { query: QueryFn; calls: Array<{ sql: string; params: any[] }> } {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query: QueryFn = async (sql, params) => {
    calls.push({ sql, params });
    return impl ? impl(sql, params) : [];
  };
  return { query, calls };
}

const allNull: TrailingReturns = { r1d: null, r1m: null, r3m: null, r6m: null, rytd: null, r1y: null, r3y: null, r5y: null };

(async () => {
  test("resolveWriteDatesBatch: empty input never calls query()", async () => {
    const { query, calls } = mockQuery();
    const result = await resolveWriteDatesBatch(query, [], "2026-10-08");
    assert.equal(calls.length, 0);
    assert.equal(result.size, 0);
  });

  test("resolveWriteDatesBatch: ONE query covers the whole batch regardless of size", async () => {
    const { query, calls } = mockQuery(() => [{ etf_id: "a", d: "2026-10-09" }, { etf_id: "b", d: "2026-10-10" }]);
    const result = await resolveWriteDatesBatch(query, ["a", "b", "c"], "2026-10-08");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].sql.includes("GROUP BY etf_id"));
    assert.equal(result.get("a"), "2026-10-09");
    assert.equal(result.get("b"), "2026-10-10");
    assert.equal(result.get("c"), undefined); // caller falls back to `today` for ids absent from the result
  });

  test("fetchLatestReturn6mBatch: empty input never calls query()", async () => {
    const { query, calls } = mockQuery();
    const result = await fetchLatestReturn6mBatch(query, []);
    assert.equal(calls.length, 0);
    assert.equal(result.size, 0);
  });

  test("fetchLatestReturn6mBatch: ONE query, numeric string parsed to number, null stays null", async () => {
    const { query, calls } = mockQuery(() => [{ etf_id: "a", r6m: "2.3400" }, { etf_id: "b", r6m: null }]);
    const result = await fetchLatestReturn6mBatch(query, ["a", "b"]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].sql.includes("DISTINCT ON (etf_id)"));
    assert.equal(result.get("a"), 2.34);
    assert.equal(result.get("b"), null);
  });

  test("writeEtfsRankingColumnsBatch: empty input never calls query()", async () => {
    const { query, calls } = mockQuery();
    await writeEtfsRankingColumnsBatch(query, []);
    assert.equal(calls.length, 0);
  });

  test("writeEtfsRankingColumnsBatch: ONE query for the whole batch, DIRECT overwrite (no COALESCE), return_6m comes from return6mSync not returns.r6m", async () => {
    const { query, calls } = mockQuery();
    const entries: EtfsRankingEntry[] = [
      { etfId: "a", returns: { ...allNull, r1m: 1.5, r6m: 999 }, return6mSync: 2.34 }, // r6m on `returns` must be ignored
      { etfId: "b", returns: allNull, return6mSync: null },
    ];
    await writeEtfsRankingColumnsBatch(query, entries);
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].sql.includes("COALESCE"));
    assert.ok(calls[0].sql.includes("jsonb_to_recordset"));
    const payload = JSON.parse(calls[0].params[0]);
    assert.equal(payload[0].return_6m, 2.34); // from return6mSync, not from returns.r6m (999)
    assert.equal(payload[0].return_1m, 1.5);
    assert.equal(payload[1].return_6m, null);
  });

  test("writeEtfsRankingColumnsBatch: a query failure is swallowed (best-effort, never throws)", async () => {
    const query: QueryFn = async () => { throw new Error("db down"); };
    await assert.doesNotReject(() => writeEtfsRankingColumnsBatch(query, [{ etfId: "a", returns: allNull, return6mSync: null }]));
  });

  test("fetchLatestLongPeriodReturnsBatch: empty input never calls query()", async () => {
    const { query, calls } = mockQuery();
    const result = await fetchLatestLongPeriodReturnsBatch(query, []);
    assert.equal(calls.length, 0);
    assert.equal(result.size, 0);
  });

  test("fetchLatestLongPeriodReturnsBatch: ONE query, numeric strings parsed, null stays null", async () => {
    const { query, calls } = mockQuery(() => [{ etf_id: "a", rytd: "1.60", r1y: "-6.35", r3y: "-21.22", r5y: null }]);
    const result = await fetchLatestLongPeriodReturnsBatch(query, ["a"]);
    assert.equal(calls.length, 1);
    assert.deepEqual(result.get("a"), { rytd: 1.6, r1y: -6.35, r3y: -21.22, r5y: null });
  });

  // 2026-11-09 模擬器實測第2項: 00674R近1年從-6.35%一天內跳到+367.03%這類髒資料防呆。
  test("isImplausibleReturnJump: no previous value never blocks a first write", () => {
    assert.equal(isImplausibleReturnJump(null, 367.03), false);
  });
  test("isImplausibleReturnJump: a real value regressing to null IS implausible", () => {
    assert.equal(isImplausibleReturnJump(1.6, null), true);
  });
  test("isImplausibleReturnJump: ordinary day-to-day drift is NOT implausible", () => {
    assert.equal(isImplausibleReturnJump(-6.35, -6.09), false);
  });
  test("isImplausibleReturnJump: a >100pp swing IS implausible (the 2026-11-09 incident)", () => {
    assert.equal(isImplausibleReturnJump(-6.35, 367.03), true);
  });

  test("longPeriodReturnsLookImplausible: no previous row never blocks a first write", () => {
    assert.equal(longPeriodReturnsLookImplausible(undefined, { rytd: 1.6, r1y: -6.35, r3y: -21.22, r5y: -14.38 }), false);
  });
  test("longPeriodReturnsLookImplausible: catches the 2026-11-09 incident shape (ytd->null, r1y/r3y blown up)", () => {
    const prev = { rytd: 1.6, r1y: -6.35, r3y: -21.22, r5y: -14.38 };
    const next = { rytd: null, r1y: 367.033, r3y: 137.2408, r5y: null };
    assert.equal(longPeriodReturnsLookImplausible(prev, next), true);
  });
  test("longPeriodReturnsLookImplausible: all four fields within normal drift is NOT implausible", () => {
    const prev = { rytd: 1.6, r1y: -6.35, r3y: -21.22, r5y: -14.38 };
    const next = { rytd: 2.68, r1y: -6.09, r3y: -20.94, r5y: -14.43 };
    assert.equal(longPeriodReturnsLookImplausible(prev, next), false);
  });
})();
