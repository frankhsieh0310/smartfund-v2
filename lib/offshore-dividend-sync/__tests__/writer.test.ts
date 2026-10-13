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
    // Distinct (fundId, exDate) per candidate -- a fixed-date cycle would collide with the within-batch
    // dedup added below and silently collapse this count, so each exDate is a unique calendar day.
    const candidates = Array.from({ length: 50 }, (_, i) => {
      const d = new Date(2026, 0, 1 + i);
      const exDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return sampleCandidate("f1", exDate);
    });
    const result = await writeDistributionBatch(query, candidates);
    assert.equal(selectCalls, 1);
    assert.equal(insertCalls, 1); // one round-trip for the whole chunk, not 50
    assert.equal(result.written, 50);
  });

  await test("writeDistributionBatch: same-batch duplicate (same fundId+exDate+amount) collapses to one write", async () => {
    let insertCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [];
      insertCalls++;
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    // Mirrors the live SITCA-republish case: identical fundId/exDate/amount, only payDate differs.
    const a = sampleCandidate("f1", "2026-10-08");
    const b = { ...a, record: { ...a.record, payDate: "2026-10-09" } };
    const result = await writeDistributionBatch(query, [a, b]);
    assert.equal(insertCalls, 1);
    assert.equal(result.written, 1);
    assert.equal(result.duplicatesCollapsed, 1);
    assert.equal(result.conflicts.length, 0);
  });

  await test("writeDistributionBatch: same-batch conflict (same fundId+exDate, different amount) is NOT written, logged instead", async () => {
    let insertCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [];
      insertCalls++;
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    // Mirrors the live 88315292B/D 2024-03 case: same exDate, genuinely different amount -- neither side
    // should be guessed at as "correct".
    const a = sampleCandidate("f1", "2026-10-08");
    const b = { ...a, record: { ...a.record, amount: 0.09 } };
    const result = await writeDistributionBatch(query, [a, b]);
    assert.equal(insertCalls, 0); // nothing left to write after both conflicting rows are excluded
    assert.equal(result.written, 0);
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.conflicts[0].amounts.slice().sort(), [0.03, 0.09]);
    assert.equal(result.conflicts[0].count, 2);
  });

  await test("writeDistributionBatch: ON CONFLICT 42P10 (unique index not yet created) falls back to a plain INSERT", async () => {
    let attempts = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [];
      attempts++;
      if (attempts === 1) {
        assert.match(sql, /ON CONFLICT/);
        const e: any = new Error("no unique or exclusion constraint matching the ON CONFLICT specification");
        e.code = "42P10";
        throw e;
      }
      assert.doesNotMatch(sql, /ON CONFLICT/);
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    const result = await writeDistributionBatch(query, [sampleCandidate("f1", "2026-10-08")]);
    assert.equal(attempts, 2); // first attempt (with ON CONFLICT) fails 42P10, retries without it
    assert.equal(result.written, 1);
    assert.equal(result.writeErrorCount, 0);
  });

  await test("writeDistributionBatch: a non-42P10 insert error does NOT retry, just fails the chunk", async () => {
    let attempts = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [];
      attempts++;
      throw new Error("connection reset");
    };
    const result = await writeDistributionBatch(query, [sampleCandidate("f1", "2026-10-08")]);
    assert.equal(attempts, 1); // no retry for a generic error
    assert.equal(result.written, 0);
    assert.equal(result.writeErrorCount, 1);
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
