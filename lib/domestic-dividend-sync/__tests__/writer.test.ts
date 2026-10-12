import assert from "node:assert/strict";
import { writeDividendBatch, writeBatchIfEnabled, SOURCE, WRITE_CHUNK_SIZE } from "../writer.ts";
import type { DividendMatchResult } from "../types.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  return p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
}

const candidate = (fundId: string, exDate: string): DividendMatchResult => ({
  fundId, sitcaCurrency: "TWD", fundCurrency: "TWD", matchedBy: "CODE",
  row: { fundType: "AA1", taxId: "x", fundName: "x", currency: "TWD", baseDate: "2026-08-24", exDate, payDate: "2026-09-04", amount: 0.1 },
});

(async () => {
  await test("writeDividendBatch: empty input never calls query()", async () => {
    let calls = 0;
    await writeDividendBatch(async () => { calls++; return []; }, []);
    assert.equal(calls, 0);
  });

  await test("writeBatchIfEnabled: write disabled -> query() is called exactly 0 times", async () => {
    let calls = 0;
    const result = await writeBatchIfEnabled(async () => { calls++; return []; }, [candidate("f1", "2026-08-18")], false);
    assert.equal(calls, 0);
    assert.equal(result.written, 0);
  });

  await test("writeDividendBatch: many candidates in one chunk -> exactly ONE INSERT round-trip (batched, not per-row)", async () => {
    let selectCalls = 0, insertCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) { selectCalls++; return []; }
      insertCalls++;
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    // 900+ candidates, as the user explicitly asked to simulate (realistic historical-backfill scale)
    const candidates = Array.from({ length: 937 }, (_, i) => candidate(`f${i % 50}`, `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`));
    const start = Date.now();
    const result = await writeDividendBatch(query, candidates);
    const elapsedMs = Date.now() - start;
    assert.equal(selectCalls, 1);
    assert.equal(insertCalls, Math.ceil(937 / WRITE_CHUNK_SIZE)); // chunked round-trips, not 937
    assert.equal(result.written, 937);
    console.log(`    (937 candidates batched in ${insertCalls} INSERT round-trip(s), ${elapsedMs}ms with a mock query)`);
  });

  await test("writeDividendBatch: skips a (fund_id, ex_date) pair that already exists for this source", async () => {
    let insertCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [{ fund_id: "f1", ex_date: "2026-08-18" }];
      insertCalls++;
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    const result = await writeDividendBatch(query, [candidate("f1", "2026-08-18"), candidate("f1", "2026-09-18")]);
    assert.equal(insertCalls, 1);
    assert.equal(result.written, 1);
    assert.equal(result.skippedExisting, 1);
  });

  await test("SOURCE constant matches the route's PROVIDER label convention", () => {
    assert.equal(SOURCE, "SITCA_FSC_OFFICIAL_MONTHLY");
  });
})();
