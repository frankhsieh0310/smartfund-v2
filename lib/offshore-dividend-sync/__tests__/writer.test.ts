import assert from "node:assert/strict";
import { writeDistributionBatch, writeBatchIfEnabled, SOURCE } from "../writer.ts";

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

  await test("writeDistributionBatch: skips a (fund_id, ex_date) pair that already exists for this source", async () => {
    let selectCalls = 0, insertCalls = 0;
    const query = async (sql: string) => {
      if (sql.includes("SELECT fund_id")) { selectCalls++; return [{ fund_id: "f1", ex_date: "2026-10-08" }]; }
      insertCalls++;
      return [];
    };
    const result = await writeDistributionBatch(query, [sampleCandidate("f1", "2026-10-08"), sampleCandidate("f1", "2026-11-08")]);
    assert.equal(selectCalls, 1);
    assert.equal(insertCalls, 1); // only the non-duplicate row
    assert.equal(result.written, 1);
    assert.equal(result.skippedExisting, 1);
  });

  await test("writeDistributionBatch: one failing row never blocks the others", async () => {
    let n = 0;
    const query = async (sql: string) => {
      if (sql.includes("SELECT fund_id")) return [];
      n++;
      if (n === 2) throw new Error("simulated failure");
      return [];
    };
    const result = await writeDistributionBatch(query, [
      sampleCandidate("f1", "2026-09-08"), sampleCandidate("f1", "2026-10-08"), sampleCandidate("f1", "2026-11-08"),
    ]);
    assert.equal(result.written, 2);
    assert.equal(result.writeErrorCount, 1);
  });

  await test("SOURCE constant matches the route's PROVIDER label convention", () => {
    assert.equal(SOURCE, "FUNDCLEAR_TDCC_OFFSHORE");
  });
})();
