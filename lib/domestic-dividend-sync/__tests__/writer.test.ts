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

  await test("writeDividendBatch: skips a (fund_id, record_date, ex_date) tuple that already exists for this source", async () => {
    let insertCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [{ fund_id: "f1", record_date: "2026-08-24", ex_date: "2026-08-18" }];
      insertCalls++;
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    const result = await writeDividendBatch(query, [candidate("f1", "2026-08-18"), candidate("f1", "2026-09-18")]);
    assert.equal(insertCalls, 1);
    assert.equal(result.written, 1);
    assert.equal(result.skippedExisting, 1);
  });

  await test("writeDividendBatch: same fundId+exDate but different baseDate (基準日) -- two real distributions, both written", async () => {
    let insertCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [];
      insertCalls++;
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    // Regression case for 88315292B/D 2024-03: same exDate, different baseDate/amount -- must NOT be
    // treated as a conflict or collapsed, because baseDate (基準日) distinguishes two real events.
    const a: DividendMatchResult = { ...candidate("88315292B", "2024-03-04"), row: { ...candidate("88315292B", "2024-03-04").row, baseDate: "2024-03-01", amount: 0.10147 } };
    const b: DividendMatchResult = { ...candidate("88315292B", "2024-03-04"), row: { ...candidate("88315292B", "2024-03-04").row, baseDate: "2024-04-01", amount: 0.09417 } };
    const result = await writeDividendBatch(query, [a, b]);
    assert.equal(insertCalls, 1);
    assert.equal(result.written, 2);
    assert.equal(result.duplicatesCollapsed, 0);
    assert.equal(result.conflicts.length, 0);
  });

  await test("writeDividendBatch: same-batch duplicate (same fundId+exDate+amount) collapses to one write", async () => {
    let insertCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [];
      insertCalls++;
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    // Mirrors the live SITCA-republish case confirmed 2026-10-13: identical fundId/exDate/amount, only
    // payDate differs by a day.
    const a = candidate("f1", "2026-08-18");
    const b = { ...a, row: { ...a.row, payDate: "2026-09-05" } };
    const result = await writeDividendBatch(query, [a, b]);
    assert.equal(insertCalls, 1);
    assert.equal(result.written, 1);
    assert.equal(result.duplicatesCollapsed, 1);
    assert.equal(result.conflicts.length, 0);
  });

  await test("writeDividendBatch: same-batch conflict (same fundId+exDate, different amount) is NOT written, logged instead", async () => {
    let insertCalls = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [];
      insertCalls++;
      const payload = JSON.parse(params[0]);
      return payload.map((_: unknown, i: number) => ({ id: `row-${i}` }));
    };
    // Mirrors the live 88315292B/D 2024-03 case: same exDate, genuinely two independent distribution
    // events with different amounts -- neither is guessed at as "correct".
    const a = candidate("f1", "2026-08-18");
    const b = { ...a, row: { ...a.row, amount: 0.2 } };
    const result = await writeDividendBatch(query, [a, b]);
    assert.equal(insertCalls, 0);
    assert.equal(result.written, 0);
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.conflicts[0].amounts.slice().sort(), [0.1, 0.2]);
    assert.equal(result.conflicts[0].count, 2);
  });

  await test("writeDividendBatch: ON CONFLICT 42P10 (unique index not yet created) falls back to a plain INSERT", async () => {
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
    const result = await writeDividendBatch(query, [candidate("f1", "2026-08-18")]);
    assert.equal(attempts, 2);
    assert.equal(result.written, 1);
    assert.equal(result.writeErrorCount, 0);
  });

  await test("writeDividendBatch: a non-42P10 insert error does NOT retry, just fails the chunk", async () => {
    let attempts = 0;
    const query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT fund_id")) return [];
      attempts++;
      throw new Error("connection reset");
    };
    const result = await writeDividendBatch(query, [candidate("f1", "2026-08-18")]);
    assert.equal(attempts, 1);
    assert.equal(result.written, 0);
    assert.equal(result.writeErrorCount, 1);
  });

  await test("SOURCE constant matches the route's PROVIDER label convention", () => {
    assert.equal(SOURCE, "SITCA_FSC_OFFICIAL_MONTHLY");
  });
})();
