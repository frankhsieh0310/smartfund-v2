import assert from "node:assert/strict";
import { writeDistributionBatch, writeBatchIfEnabled, SOURCE, WRITE_CHUNK_SIZE } from "../writer.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  return p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
}

const sampleCandidate = (fundId: string, exDate: string) => ({
  fundId, currency: "USD",
  record: { baseDate: "2026-09-30", exDate, payDate: "2026-10-08", amount: 0.03, frequency: "每月", incomeRatioPct: 80, returnOfCapitalRatioPct: 20 },
});

(async () => {
  await test("writeDistributionBatch: empty input never calls query()", async () => {
    let calls = 0;
    await writeDistributionBatch(async () => { calls++; return []; }, []);
    assert.equal(calls, 0);
  });

  await test("writeBatchIfEnabled: write disabled -> query() is called exactly 0 times", async () => {
    let calls = 0;
    const result = await writeBatchIfEnabled(async () => { calls++; return []; }, [sampleCandidate("f1", "2026-10-08")], false);
    assert.equal(calls, 0);
    assert.equal(result.written, 0);
  });

  await test("writeDistributionBatch: multiple candidates in one chunk -> exactly ONE INSERT round-trip (batched, not per-row)", async () => {
    let selectCalls = 0, insertCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) { selectCalls++; return []; }
      insertCalls++;
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    const candidates = Array.from({ length: 50 }, (_, i) => sampleCandidate("f1", `2026-${String((i % 12) + 1).padStart(2, "0")}-08`));
    const result = await writeDistributionBatch(query, candidates);
    assert.equal(selectCalls, 1);
    assert.equal(insertCalls, 1); // one round-trip for the whole chunk, not 50
    assert.equal(result.written, 50);
  });

  await test("writeDistributionBatch: skips a (fund_id, ex_date) pair that already exists for this source", async () => {
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [{ fund_id: "f1", ex_date: "2026-10-08" }];
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    const result = await writeDistributionBatch(query, [sampleCandidate("f1", "2026-10-08"), sampleCandidate("f1", "2026-11-08")]);
    assert.equal(result.written, 1);
    assert.equal(result.skippedExisting, 1);
  });

  await test("writeDistributionBatch: a whole chunk failing never blocks a later chunk", async () => {
    let chunkCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [];
      chunkCalls++;
      if (chunkCalls === 1) throw new Error("simulated chunk failure");
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    const candidates = Array.from({ length: WRITE_CHUNK_SIZE + 10 }, (_, i) => sampleCandidate(`f${i}`, "2026-10-08"));
    const result = await writeDistributionBatch(query, candidates);
    assert.equal(result.written, 10); // first chunk (200) failed, second chunk (10) succeeded
    assert.equal(result.writeErrorCount, WRITE_CHUNK_SIZE);
  });

  await test("SOURCE constant matches the route's PROVIDER label convention", () => {
    assert.equal(SOURCE, "FUNDCLEAR_TDCC_OFFSHORE");
  });
})();
