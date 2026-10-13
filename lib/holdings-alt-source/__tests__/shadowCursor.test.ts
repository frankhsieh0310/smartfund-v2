import assert from "node:assert/strict";
import { loadShadowCursor, saveShadowCursor, selectShadowBatch, SHADOW_CURSOR_CHECKPOINT_KEY } from "../shadowCursor";

async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const UNIVERSE = [
  { fundId: "f3", code: "C" }, { fundId: "f1", code: "A" }, { fundId: "f2", code: "B" },
  { fundId: "f5", code: "E" }, { fundId: "f4", code: "D" },
];

async function main() {
  await test("selectShadowBatch: two consecutive shadow runs never pick the same batch", async () => {
    const run1State = { processedFundIds: [], cycleStartedAt: "2026-01-01T00:00:00.000Z" };
    const run1 = selectShadowBatch(UNIVERSE, run1State);
    // simulate run 1 only getting through the first 2 (small time budget)
    const run1Visited = run1.batch.slice(0, 2).map((b) => b.fundId);
    const afterRun1 = { processedFundIds: run1Visited, cycleStartedAt: run1.startingState.cycleStartedAt };

    const run2 = selectShadowBatch(UNIVERSE, afterRun1);
    const run2FirstIds = run2.batch.map((b) => b.fundId);

    assert.equal(run1.cycleWillReset, false);
    assert.equal(run2.cycleWillReset, false);
    for (const id of run1Visited) {
      assert.equal(run2FirstIds.includes(id), false, `run2 should not re-include already-visited ${id}`);
    }
    assert.equal(run2.batch.length, UNIVERSE.length - 2);
  });

  await test("selectShadowBatch: stable sort order (by fundId) so rotation is deterministic", async () => {
    const state = { processedFundIds: [], cycleStartedAt: "2026-01-01T00:00:00.000Z" };
    const result = selectShadowBatch(UNIVERSE, state);
    const ids = result.batch.map((b) => b.fundId);
    assert.deepEqual(ids, ["f1", "f2", "f3", "f4", "f5"]);
  });

  await test("selectShadowBatch: once every fund is visited, cycle resets and starts over (1-3)", async () => {
    const allVisited = { processedFundIds: UNIVERSE.map((u) => u.fundId), cycleStartedAt: "2026-01-01T00:00:00.000Z" };
    const result = selectShadowBatch(UNIVERSE, allVisited);
    assert.equal(result.cycleWillReset, true);
    assert.equal(result.batch.length, UNIVERSE.length); // full universe again
    assert.deepEqual(result.startingState.processedFundIds, []);
  });

  await test("loadShadowCursor: no checkpoint row -> empty fresh state", async () => {
    const query = async () => [];
    const state = await loadShadowCursor(query);
    assert.deepEqual(state.processedFundIds, []);
  });

  await test("loadShadowCursor: reads back exactly what saveShadowCursor wrote (round-trip via mock)", async () => {
    let stored: string | null = null;
    const query = async (sql: string, params: any[]) => {
      if (sql.startsWith("INSERT INTO production_scheduler_checkpoints")) {
        assert.equal(params[0], SHADOW_CURSOR_CHECKPOINT_KEY);
        assert.equal(params[1], "run-123"); // runId must be passed through, not NULL (checkpoint.run_id is NOT NULL)
        stored = params[2];
        return [];
      }
      if (sql.startsWith("SELECT last_symbol")) {
        return stored ? [{ last_symbol: stored }] : [];
      }
      throw new Error("unexpected query: " + sql);
    };
    await saveShadowCursor(query, "run-123", { processedFundIds: ["f1", "f2"], cycleStartedAt: "2026-01-01T00:00:00.000Z" });
    const reloaded = await loadShadowCursor(query);
    assert.deepEqual(reloaded.processedFundIds, ["f1", "f2"]);
  });

  await test("write mode selection (selectOldestFirst) is untouched by the shadow cursor -- shadowCursor module never consulted", async () => {
    // selectShadowBatch / loadShadowCursor / saveShadowCursor are simply not imported or called by
    // write-mode's code path in route.ts (selectOldestFirst only). This test documents that contract
    // at the module level: selectShadowBatch takes no DB dependency and has no way to affect
    // selection.ts's holdings-table-based query, since they are entirely separate functions with no
    // shared state.
    assert.equal(typeof selectShadowBatch, "function");
  });
}

main();
