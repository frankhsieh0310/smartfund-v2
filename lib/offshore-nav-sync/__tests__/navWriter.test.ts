import assert from "node:assert/strict";
import { writeOffshoreNavBatch, writeBatchIfEnabled, type QueryFn } from "../navWriter.ts";

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
  test("writeOffshoreNavBatch: empty input never calls query()", async () => {
    const { query, calls } = mockQuery();
    const r = await writeOffshoreNavBatch(query, [], "2026-10-12T00:00:00Z");
    assert.equal(calls.length, 0);
    assert.deepEqual(r, { written: 0, writeErrorCount: 0, writeErrorFundIds: [] });
  });

  test("writeOffshoreNavBatch: forward-only date rule, no same-date-different-value clause", async () => {
    // Simulates the real RETURNING f.id -- one row back per candidate the UPDATE actually matched.
    const { query, calls } = mockQuery((sql, params) => {
      const payload = JSON.parse(params[0] as string);
      return payload.map(() => ({ id: "x" }));
    });
    const r = await writeOffshoreNavBatch(query, [{ fundId: "f1", navDate: "2026-10-09", nav: 8.46 }], "2026-10-12T00:00:00Z");
    assert.equal(calls.length, 2);
    assert.ok(calls[0].sql.includes("INSERT INTO fund_history"));
    assert.ok(calls[1].sql.includes("UPDATE funds"));
    assert.ok(calls[1].sql.includes("last_nav_source = 'YAHOO_FUND_PRICE_HISTORY'"));
    assert.ok(calls[1].sql.includes("f.latest_nav_date IS NULL OR f.latest_nav_date < x.date::date"));
    assert.ok(!calls[1].sql.includes("IS DISTINCT FROM x.nav")); // strictly forward-only, no same-date-update clause
    assert.equal(r.written, 1);
  });

  test("writeOffshoreNavBatch: chunks at 200, one failing chunk never blocks the other", async () => {
    let firstChunkFailed = false;
    const query: QueryFn = async (sql, params) => {
      const payload = typeof params[0] === "string" ? params[0] : "";
      if (sql.includes("INSERT INTO fund_history") && payload.includes('"f0"')) {
        firstChunkFailed = true;
        throw new Error("db error on first chunk");
      }
      return payload ? JSON.parse(payload).map(() => ({ id: "x" })) : [];
    };
    const candidates = Array.from({ length: 250 }, (_, i) => ({ fundId: `f${i}`, navDate: "2026-10-09", nav: 10 }));
    const r = await writeOffshoreNavBatch(query, candidates, "2026-10-12T00:00:00Z");
    assert.equal(firstChunkFailed, true);
    assert.equal(r.writeErrorCount, 200);
    assert.equal(r.written, 50);
  });

  test("writeBatchIfEnabled: write disabled -> query() is called exactly 0 times", async () => {
    const { query, calls } = mockQuery();
    await writeBatchIfEnabled(query, [{ fundId: "f1", navDate: "2026-10-09", nav: 8.46 }], "2026-10-12T00:00:00Z", false);
    assert.equal(calls.length, 0);
  });
})();
