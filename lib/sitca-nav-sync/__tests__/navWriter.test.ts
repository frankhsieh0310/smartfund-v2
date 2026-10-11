import assert from "node:assert/strict";
import { writeSitcaNavBatch, writeBatchIfEnabled, type QueryFn } from "../navWriter.ts";

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
  test("writeSitcaNavBatch: empty input never calls query()", async () => {
    const { query, calls } = mockQuery();
    const r = await writeSitcaNavBatch(query, [], "2026-10-12T00:00:00Z");
    assert.equal(calls.length, 0);
    assert.deepEqual(r, { written: 0, writeErrorCount: 0, writeErrorFundIds: [] });
  });

  test("writeSitcaNavBatch: two queries (fund_history upsert + newer-or-same-date-different-value update)", async () => {
    const { query, calls } = mockQuery();
    const r = await writeSitcaNavBatch(query, [{ fundId: "f1", navDate: "2026-10-09", nav: 8.46, matchedBy: "CODE" }], "2026-10-12T00:00:00Z");
    assert.equal(calls.length, 2);
    assert.ok(calls[0].sql.includes("INSERT INTO fund_history"));
    assert.ok(calls[1].sql.includes("UPDATE funds"));
    assert.ok(calls[1].sql.includes("last_nav_source = 'SITCA_FSC_OFFICIAL_DAILY_NAV_CSV'"));
    assert.ok(calls[1].sql.includes("f.latest_nav_date = x.date::date AND f.latest_nav IS DISTINCT FROM x.nav"));
    assert.equal(r.written, 1);
  });

  test("writeSitcaNavBatch: chunks at 500, one failing chunk never blocks the other", async () => {
    let firstChunkFailed = false;
    const query: QueryFn = async (sql, params) => {
      // The first chunk's fund_history payload always contains "f0" (its first candidate);
      // the second chunk's never does — a reliable way to identify "this is chunk 1" regardless
      // of insert-vs-update call ordering.
      const payload = typeof params[0] === "string" ? params[0] : "";
      if (sql.includes("INSERT INTO fund_history") && payload.includes('"f0"')) {
        firstChunkFailed = true;
        throw new Error("db error on first chunk");
      }
      return [];
    };
    const candidates = Array.from({ length: 600 }, (_, i) => ({ fundId: `f${i}`, navDate: "2026-10-09", nav: 10, matchedBy: "CODE" as const }));
    const r = await writeSitcaNavBatch(query, candidates, "2026-10-12T00:00:00Z");
    assert.equal(firstChunkFailed, true);
    assert.equal(r.writeErrorCount, 500); // first chunk (500) failed
    assert.equal(r.written, 100); // second chunk (100) succeeded
  });

  test("writeBatchIfEnabled: write disabled -> query() is called exactly 0 times", async () => {
    const { query, calls } = mockQuery();
    await writeBatchIfEnabled(query, [{ fundId: "f1", navDate: "2026-10-09", nav: 8.46, matchedBy: "CODE" }], "2026-10-12T00:00:00Z", false);
    assert.equal(calls.length, 0);
  });
})();
