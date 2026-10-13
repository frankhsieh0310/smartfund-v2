import assert from "node:assert/strict";
import { loadRotationProgress, saveRotationProgress, selectRotationBatch, PROGRESS_CHECKPOINT_KEY } from "../completion.ts";

async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const UNIVERSE = [
  { id: "f3", code: "C" }, { id: "f1", code: "A" }, { id: "f2", code: "B" },
  { id: "f5", code: "E" }, { id: "f4", code: "D" },
];

async function main() {
  await test("selectRotationBatch: stable sort order (by id) so rotation is deterministic", () => {
    const result = selectRotationBatch(UNIVERSE, new Set());
    assert.deepEqual(result.pending.map((u) => u.id), ["f1", "f2", "f3", "f4", "f5"]);
    assert.equal(result.cycleWillReset, false);
  });

  await test("selectRotationBatch: two consecutive runs never re-pick an already-processed fund within a cycle", () => {
    const run1 = selectRotationBatch(UNIVERSE, new Set());
    const run1Visited = run1.pending.slice(0, 2).map((u) => u.id); // simulate a run cut off after 2
    const run2 = selectRotationBatch(UNIVERSE, new Set(run1Visited));
    const run2Ids = run2.pending.map((u) => u.id);
    assert.equal(run2.cycleWillReset, false);
    for (const id of run1Visited) assert.equal(run2Ids.includes(id), false);
    assert.equal(run2.pending.length, UNIVERSE.length - 2);
  });

  await test("selectRotationBatch: NOT tied to any calendar date -- progress from a prior invocation carries forward regardless of day boundary", () => {
    // This is the core regression case: the old day-scoped checkpoint reset to empty whenever the
    // stored date didn't match "today". The new cursor takes no date/today input at all, so there is no
    // mechanism left that could reset progress just because a day rolled over.
    const yesterdaysProgress = new Set(["f1", "f2", "f3"]);
    const result = selectRotationBatch(UNIVERSE, yesterdaysProgress);
    assert.deepEqual(result.pending.map((u) => u.id), ["f4", "f5"]);
    assert.equal(result.cycleWillReset, false);
  });

  await test("selectRotationBatch: once every fund is processed, the cycle resets and starts over", () => {
    const allProcessed = new Set(UNIVERSE.map((u) => u.id));
    const result = selectRotationBatch(UNIVERSE, allProcessed);
    assert.equal(result.cycleWillReset, true);
    assert.equal(result.pending.length, UNIVERSE.length);
    assert.deepEqual(result.startingProcessed, new Set());
  });

  await test("selectRotationBatch: empty universe never resets or crashes", () => {
    const result = selectRotationBatch([], new Set());
    assert.equal(result.cycleWillReset, false);
    assert.equal(result.pending.length, 0);
  });

  await test("loadRotationProgress: no checkpoint row -> empty fresh state", async () => {
    const query = async () => [];
    const state = await loadRotationProgress(query);
    assert.deepEqual([...state], []);
  });

  await test("saveRotationProgress / loadRotationProgress: round-trip via mock, run_id passed through (NOT NULL column)", async () => {
    let stored: string | null = null;
    const query = async (sql: string, params: any[]) => {
      if (sql.startsWith("INSERT INTO production_scheduler_checkpoints")) {
        assert.equal(params[0], PROGRESS_CHECKPOINT_KEY);
        assert.equal(params[1], "run-456");
        stored = params[2];
        return [];
      }
      if (sql.startsWith("SELECT last_symbol")) {
        return stored ? [{ last_symbol: stored }] : [];
      }
      throw new Error("unexpected query: " + sql);
    };
    await saveRotationProgress(query, "run-456", new Set(["f1", "f2"]));
    const reloaded = await loadRotationProgress(query);
    assert.deepEqual([...reloaded].sort(), ["f1", "f2"]);
  });
}

main();
