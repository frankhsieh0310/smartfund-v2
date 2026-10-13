import assert from "node:assert/strict";
import { lookupDoneFundIds, type QueryFn } from "../completion.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
  return p;
}

(async () => {
  test("lookupDoneFundIds: empty input never calls query()", async () => {
    let calls = 0;
    const query: QueryFn = async () => { calls++; return []; };
    const r = await lookupDoneFundIds(query, [], "2026-10-09");
    assert.equal(calls, 0);
    assert.equal(r.size, 0);
  });

  test("lookupDoneFundIds: one query, returns exactly the done set", async () => {
    let calls = 0;
    const query: QueryFn = async () => { calls++; return [{ fund_id: "a" }, { fund_id: "c" }]; };
    const r = await lookupDoneFundIds(query, ["a", "b", "c"], "2026-10-09");
    assert.equal(calls, 1);
    assert.equal(r.has("a"), true);
    assert.equal(r.has("b"), false);
    assert.equal(r.has("c"), true);
  });
})();
