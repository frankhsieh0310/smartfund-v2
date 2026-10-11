import assert from "node:assert/strict";
import { inRange, sanitizeReturns, writeReturnsBatch, writeBatchIfEnabled, type TrailingReturns, type QueryFn } from "../returnsWriter.ts";

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
  test("inRange: within NUMERIC(8,4) bounds is true, outside is false, null is false", () => {
    assert.equal(inRange(15.63), true);
    assert.equal(inRange(-9999.9999), true);
    assert.equal(inRange(9999.9999), true);
    assert.equal(inRange(10000), false);
    assert.equal(inRange(-10000.01), false);
    assert.equal(inRange(null), false);
    assert.equal(inRange(NaN), false);
    assert.equal(inRange(Infinity), false);
  });

  await test("sanitizeReturns: drops only the out-of-range field, keeps the rest", () => {
    const { sanitized, droppedFields } = sanitizeReturns({ ...allNull, r1m: 15.63, r3y: 123456.78 });
    assert.equal(sanitized.r1m, 15.63);
    assert.equal(sanitized.r3y, null);
    assert.deepEqual(droppedFields, ["r3y"]);
  });

  await test("sanitizeReturns: all-null input drops nothing (nothing to drop) and stays all-null", () => {
    const { sanitized, droppedFields } = sanitizeReturns(allNull);
    assert.deepEqual(sanitized, allNull);
    assert.deepEqual(droppedFields, []);
  });

  await test("writeReturnsBatch: empty input never calls query() at all", async () => {
    const { query, calls } = mockQuery();
    const result = await writeReturnsBatch(query, [], "2026-10-11T00:00:00Z");
    assert.equal(calls.length, 0);
    assert.deepEqual(result, { written: 0, droppedFieldCount: 0, writeErrorCount: 0, writeErrorEtfIds: [] });
  });

  await test("writeReturnsBatch: SQL uses ON CONFLICT (etf_id, date) with COALESCE — same shape as the existing Yahoo enrichment pipeline, batched (one call for the whole set)", async () => {
    const { query, calls } = mockQuery();
    await writeReturnsBatch(query, [{ etfId: "a", date: "2026-10-09", returns: { ...allNull, r1m: 1.5 } }], "2026-10-11T00:00:00Z");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].sql.includes("ON CONFLICT (etf_id, date)"));
    assert.ok(calls[0].sql.includes("COALESCE(EXCLUDED.return_1m"));
    assert.ok(calls[0].sql.includes("jsonb_to_recordset"));
  });

  await test("writeReturnsBatch: an out-of-range field is dropped (null) before the write, reported via droppedFieldCount, row is still written", async () => {
    const { query, calls } = mockQuery();
    const result = await writeReturnsBatch(query, [{ etfId: "a", date: "2026-10-09", returns: { ...allNull, r1m: 1.5, r3y: 999999 } }], "2026-10-11T00:00:00Z");
    assert.equal(result.written, 1);
    assert.equal(result.droppedFieldCount, 1);
    const payload = JSON.parse(calls[0].params[0]);
    assert.equal(payload[0].return_3y, null);
    assert.equal(payload[0].return_1m, 1.5);
  });

  await test("Task X B.3: writeReturnsBatch isolates a write failure — catches the error, reports writeErrorCount/writeErrorEtfIds, never throws, so one bad batch never aborts the whole invocation", async () => {
    const query: QueryFn = async () => { throw new Error("simulated DB error"); };
    const result = await writeReturnsBatch(query, [
      { etfId: "a", date: "2026-10-09", returns: allNull },
      { etfId: "b", date: "2026-10-09", returns: allNull },
    ], "2026-10-11T00:00:00Z");
    assert.equal(result.written, 0);
    assert.equal(result.writeErrorCount, 2);
    assert.deepEqual(result.writeErrorEtfIds.sort(), ["a", "b"]);
  });

  await test("writeBatchIfEnabled: write disabled -> query() is called exactly 0 times", async () => {
    const { query, calls } = mockQuery();
    const result = await writeBatchIfEnabled(query, [{ etfId: "a", date: "2026-10-09", returns: allNull }], "2026-10-11T00:00:00Z", false);
    assert.equal(calls.length, 0);
    assert.deepEqual(result, { written: 0, droppedFieldCount: 0, writeErrorCount: 0, writeErrorEtfIds: [] });
  });

  console.log("RETURNS_WRITER_TESTS_DONE");
})();
