import assert from "node:assert/strict";
import {
  resolveWriteDatesBatch, fetchLatestReturn6mBatch, writeEtfsRankingColumnsBatch, type EtfsRankingEntry, type QueryFn,
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
})();
