import assert from "node:assert/strict";
import { writeFundNavBatch, writeBatchIfEnabled, type QueryFn } from "../navWriter.ts";

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

(async () => {
  test("writeFundNavBatch: empty input never calls query()", async () => {
    const { query, calls } = mockQuery();
    const r = await writeFundNavBatch(query, [], "2026-10-11T00:00:00Z");
    assert.equal(calls.length, 0);
    assert.deepEqual(r, { written: 0, writeErrorCount: 0, writeErrorFundIds: [] });
  });

  test("writeFundNavBatch: two queries (fund_history upsert + newer-or-same-date-different-value funds update), batched", async () => {
    const { query, calls } = mockQuery();
    const r = await writeFundNavBatch(query, [{ fundId: "a", symbol: "AFDAX", date: "2026-10-09", nav: 51.83 }], "2026-10-11T00:00:00Z");
    assert.equal(calls.length, 2);
    assert.ok(calls[0].sql.includes("INSERT INTO fund_history"));
    assert.ok(calls[0].sql.includes("ON CONFLICT (fund_id, date)"));
    assert.ok(calls[1].sql.includes("UPDATE funds"));
    assert.ok(calls[1].sql.includes("latest_nav_date IS NULL OR f.latest_nav_date < x.date::date"));
    // Task Z: aligned with fundIngest.ts/fundNav.ts's own rule — also updates on a same-date value
    // disagreement, not just a strictly newer date.
    assert.ok(calls[1].sql.includes("f.latest_nav_date = x.date::date AND f.latest_nav IS DISTINCT FROM x.nav"));
    assert.equal(r.written, 1);
  });

  test("writeFundNavBatch: a query failure reports writeErrorCount for the whole batch, never throws", async () => {
    const query: QueryFn = async () => { throw new Error("db down"); };
    const r = await writeFundNavBatch(query, [{ fundId: "a", symbol: "X", date: "2026-10-09", nav: 1 }], "2026-10-11T00:00:00Z");
    assert.equal(r.writeErrorCount, 1);
    assert.deepEqual(r.writeErrorFundIds, ["a"]);
  });

  test("writeBatchIfEnabled: write disabled -> query() is called exactly 0 times", async () => {
    const { query, calls } = mockQuery();
    await writeBatchIfEnabled(query, [{ fundId: "a", symbol: "X", date: "2026-10-09", nav: 1 }], "2026-10-11T00:00:00Z", false);
    assert.equal(calls.length, 0);
  });
})();
