import assert from "node:assert/strict";
import { selectOldestFirst } from "../selection";

async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const NOW = Date.now();
function daysAgo(n: number) {
  return new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function main() {
  await test("selectOldestFirst: never-fetched funds sort first, before any dated fund", async () => {
    const query = async () => [{ fund_id: "f2", last_date: daysAgo(30) }];
    const mapping = [
      { fundId: "f1", code: "A", yahooFundId: "Y1:FO" }, // never fetched
      { fundId: "f2", code: "B", yahooFundId: "Y2:FO" }, // fetched 30 days ago (stale, eligible)
    ];
    const result = await selectOldestFirst(query, mapping, "SRC", 25);
    assert.equal(result.length, 2);
    assert.equal(result[0].fundId, "f1");
    assert.equal(result[0].lastFetchedDate, null);
    assert.equal(result[1].fundId, "f2");
  });

  await test("selectOldestFirst: funds fetched within freshDays are excluded", async () => {
    const query = async () => [{ fund_id: "f1", last_date: daysAgo(5) }];
    const mapping = [{ fundId: "f1", code: "A", yahooFundId: "Y1:FO" }];
    const result = await selectOldestFirst(query, mapping, "SRC", 25);
    assert.equal(result.length, 0);
  });

  await test("selectOldestFirst: oldest-dated fund sorts before newer-dated fund", async () => {
    const query = async () => [
      { fund_id: "f1", last_date: daysAgo(26) },
      { fund_id: "f2", last_date: daysAgo(100) },
    ];
    const mapping = [
      { fundId: "f1", code: "A", yahooFundId: "Y1:FO" },
      { fundId: "f2", code: "B", yahooFundId: "Y2:FO" },
    ];
    const result = await selectOldestFirst(query, mapping, "SRC", 25);
    assert.equal(result.length, 2);
    assert.equal(result[0].fundId, "f2"); // 100 days ago, older
    assert.equal(result[1].fundId, "f1"); // 26 days ago
  });

  await test("selectOldestFirst: empty mapping -> empty result, query() never called", async () => {
    let called = false;
    const query = async () => { called = true; return []; };
    const result = await selectOldestFirst(query, [], "SRC", 25);
    assert.equal(result.length, 0);
    assert.equal(called, false);
  });
}

main();
