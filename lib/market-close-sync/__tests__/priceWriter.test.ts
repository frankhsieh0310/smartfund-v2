import assert from "node:assert/strict";
import {
  isWritableClassification, filterWritable, writeBatchIfEnabled,
  writeEtfHistoryBatch, updateEtfsLatestForward, recomputeEtfPerformanceBatch,
  type WritablePrice, type QueryFn,
} from "../priceWriter.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
  return p;
}

const NOW_ISO = "2026-10-09T12:00:00.000Z";

function mockQuery(returnRows: Record<string, any[]> | any[] = []): { query: QueryFn; calls: Array<{ sql: string; params: any[] }> } {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query: QueryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (Array.isArray(returnRows)) return returnRows;
    for (const [marker, rows] of Object.entries(returnRows)) {
      if (sql.includes(marker)) return rows;
    }
    return [];
  };
  return { query, calls };
}

const sample = (classification: WritablePrice["classification"], etfId = "etf-1"): WritablePrice => ({
  etfId, symbol: "TEST.XX", classification, targetLocalDate: "2026-10-09", price: 100, source: "BAR",
});

(async () => {
  await test("isWritableClassification: only NEW, CHANGED, DB_DISCONTINUITY are writable", () => {
    assert.equal(isWritableClassification("NEW"), true);
    assert.equal(isWritableClassification("CHANGED"), true);
    assert.equal(isWritableClassification("DB_DISCONTINUITY"), true);
    assert.equal(isWritableClassification("SAME"), false);
    assert.equal(isWritableClassification("UNIT_MISMATCH"), false);
    assert.equal(isWritableClassification("PRICE_JUMP_REVIEW"), false);
    assert.equal(isWritableClassification("SOURCE_MISSING"), false);
    assert.equal(isWritableClassification("NO_BAR_FOR_TARGET_DATE"), false);
    assert.equal(isWritableClassification("NO_TRADE_ON_TARGET"), false);
    assert.equal(isWritableClassification("DB_NEWER"), false);
  });

  await test("filterWritable keeps only NEW/CHANGED/DB_DISCONTINUITY out of a mixed batch", () => {
    const batch = [
      sample("NEW", "a"), sample("CHANGED", "b"), sample("SAME", "c"),
      sample("UNIT_MISMATCH", "d"), sample("PRICE_JUMP_REVIEW", "e"), sample("DB_DISCONTINUITY", "f"),
    ];
    const kept = filterWritable(batch).map((r) => r.etfId);
    assert.deepEqual(kept.sort(), ["a", "b", "f"]);
  });

  await test("writeBatchIfEnabled: write disabled -> query() is called exactly 0 times, regardless of batch contents", async () => {
    const { query, calls } = mockQuery();
    const result = await writeBatchIfEnabled(query, [sample("NEW"), sample("CHANGED")], NOW_ISO, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(result, { historyWritten: 0, etfsUpdated: 0, performanceRecomputed: 0 });
  });

  await test("writeBatchIfEnabled: write enabled but batch has only UNIT_MISMATCH/PRICE_JUMP_REVIEW/SAME -> still 0 calls", async () => {
    const { query, calls } = mockQuery();
    const result = await writeBatchIfEnabled(query, [sample("UNIT_MISMATCH"), sample("PRICE_JUMP_REVIEW"), sample("SAME")], NOW_ISO, true);
    assert.equal(calls.length, 0);
    assert.deepEqual(result, { historyWritten: 0, etfsUpdated: 0, performanceRecomputed: 0 });
  });

  await test("writeBatchIfEnabled: write enabled, a mixed batch only ever writes the NEW/CHANGED/DB_DISCONTINUITY rows", async () => {
    const { query, calls } = mockQuery({ etf_history: [{ x: 1 }], "UPDATE etfs": [{ id: "a" }, { id: "b" }], etf_performances: [{ x: 1 }, { x: 1 }] });
    const batch = [sample("NEW", "a"), sample("CHANGED", "b"), sample("UNIT_MISMATCH", "c"), sample("PRICE_JUMP_REVIEW", "d"), sample("SAME", "e")];
    const result = await writeBatchIfEnabled(query, batch, NOW_ISO, true);
    // history insert + etfs update + performance recompute's own base-close lookups (6 periods) + its insert = 1 + 1 + 6 + 1 = 9 calls total
    assert.ok(calls.length > 0);
    // every call's params must only ever reference etf ids "a"/"b" — "c"/"d"/"e" never appear anywhere.
    for (const call of calls) {
      const serialized = JSON.stringify(call.params);
      assert.ok(!serialized.includes('"c"'), "UNIT_MISMATCH row must never appear in any write call");
      assert.ok(!serialized.includes('"d"'), "PRICE_JUMP_REVIEW row must never appear in any write call");
      assert.ok(!serialized.includes('"e"'), "SAME row must never appear in any write call");
    }
    assert.equal(result.historyWritten, 1);
    assert.equal(result.etfsUpdated, 2);
  });

  await test("writeEtfHistoryBatch: SQL uses ON CONFLICT (etf_id, date) with a WHERE value-changed guard, batched (one call for the whole set)", async () => {
    const { query, calls } = mockQuery([{ x: 1 }]);
    await writeEtfHistoryBatch(query, [sample("NEW", "a"), sample("CHANGED", "b")], NOW_ISO);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].sql.includes("ON CONFLICT (etf_id, date)"));
    assert.ok(calls[0].sql.includes("IS DISTINCT FROM"));
    assert.ok(calls[0].sql.includes("jsonb_to_recordset"));
  });

  await test("writeEtfHistoryBatch: empty input never calls query() at all", async () => {
    const { query, calls } = mockQuery();
    const n = await writeEtfHistoryBatch(query, [], NOW_ISO);
    assert.equal(calls.length, 0);
    assert.equal(n, 0);
  });

  await test("updateEtfsLatestForward: SQL guards on price_updated_at being null OR the new target date being strictly newer", async () => {
    const { query, calls } = mockQuery([{ id: "a" }]);
    await updateEtfsLatestForward(query, [sample("NEW", "a")], NOW_ISO);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].sql.includes("price_updated_at IS NULL"));
    assert.ok(calls[0].sql.includes("target_date::date > etfs.price_updated_at::date"));
  });

  await test("Task W6: updateEtfsLatestForward's WHERE clause never casts etf_id to ::uuid — etfs.id is a plain text column (confirmed live: 16,834/16,834 rows UUID-shaped text, no uuid column anywhere in this schema), and WHERE etfs.id = x.etf_id::uuid crashed every Production write with \"operator does not exist: text = uuid\" the one time a batch actually had a writable row", async () => {
    const { query, calls } = mockQuery([{ id: "a" }]);
    await updateEtfsLatestForward(query, [sample("NEW", "a")], NOW_ISO);
    assert.ok(!calls[0].sql.includes("etf_id::uuid"), "etfs.id = x.etf_id must compare text to text, never text to an explicit ::uuid cast");
    assert.ok(calls[0].sql.includes("etfs.id = x.etf_id"));
  });

  await test("recomputeEtfPerformanceBatch: looks up a base close for all 6 periods, batched per distinct target date, then one upsert", async () => {
    const { query, calls } = mockQuery({ "DISTINCT ON": [{ etf_id: "a", close: 90 }], etf_performances: [{ x: 1 }] });
    const n = await recomputeEtfPerformanceBatch(query, [{ etfId: "a", targetLocalDate: "2026-10-09", targetClose: 100 }], NOW_ISO);
    // 6 base-close lookups (1D/1M/3M/6M/1Y/3Y) + 1 final upsert = 7 calls for a single ETF/date.
    assert.equal(calls.length, 7);
    assert.equal(n, 1);
    const upsertCall = calls[calls.length - 1];
    assert.ok(upsertCall.sql.includes("etf_performances"));
    assert.ok(upsertCall.sql.includes("return_1d"));
    assert.ok(upsertCall.sql.includes("return_3y"));
  });

  console.log("PRICE_WRITER_TESTS_DONE");
})();
