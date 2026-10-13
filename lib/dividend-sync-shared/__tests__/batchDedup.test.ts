import assert from "node:assert/strict";
import { dedupBatchByFundExDate, isMissingUniqueConstraintError } from "../batchDedup.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

type C = { fundId: string; exDate: string; amount: number; tag: string };
const keyOf = (c: C) => ({ fundId: c.fundId, exDate: c.exDate, amount: c.amount });

test("dedupBatchByFundExDate: no collisions -> everything passes through unchanged", () => {
  const input: C[] = [
    { fundId: "f1", exDate: "2026-01-01", amount: 1, tag: "a" },
    { fundId: "f2", exDate: "2026-01-01", amount: 1, tag: "b" },
  ];
  const result = dedupBatchByFundExDate(input, keyOf);
  assert.equal(result.toWrite.length, 2);
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.conflicts.length, 0);
});

test("dedupBatchByFundExDate: same key + same amount -> collapses to the LAST occurrence", () => {
  const input: C[] = [
    { fundId: "f1", exDate: "2026-01-01", amount: 1, tag: "first" },
    { fundId: "f1", exDate: "2026-01-01", amount: 1, tag: "second" },
  ];
  const result = dedupBatchByFundExDate(input, keyOf);
  assert.equal(result.toWrite.length, 1);
  assert.equal((result.toWrite[0] as C).tag, "second");
  assert.equal(result.duplicatesCollapsed, 1);
  assert.equal(result.conflicts.length, 0);
});

test("dedupBatchByFundExDate: 3-way same-key same-amount collapses to one, collapsed count is 2", () => {
  const input: C[] = [
    { fundId: "f1", exDate: "2026-01-01", amount: 1, tag: "a" },
    { fundId: "f1", exDate: "2026-01-01", amount: 1, tag: "b" },
    { fundId: "f1", exDate: "2026-01-01", amount: 1, tag: "c" },
  ];
  const result = dedupBatchByFundExDate(input, keyOf);
  assert.equal(result.toWrite.length, 1);
  assert.equal(result.duplicatesCollapsed, 2);
});

test("dedupBatchByFundExDate: same key + different amount -> excluded entirely, reported as a conflict", () => {
  const input: C[] = [
    { fundId: "f1", exDate: "2026-01-01", amount: 1, tag: "a" },
    { fundId: "f1", exDate: "2026-01-01", amount: 2, tag: "b" },
  ];
  const result = dedupBatchByFundExDate(input, keyOf);
  assert.equal(result.toWrite.length, 0);
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].fundId, "f1");
  assert.equal(result.conflicts[0].exDate, "2026-01-01");
  assert.deepEqual(result.conflicts[0].amounts.slice().sort(), [1, 2]);
  assert.equal(result.conflicts[0].count, 2);
});

test("dedupBatchByFundExDate: a conflicting group never leaks into duplicatesCollapsed", () => {
  const input: C[] = [
    { fundId: "f1", exDate: "2026-01-01", amount: 1, tag: "a" },
    { fundId: "f1", exDate: "2026-01-01", amount: 2, tag: "b" },
    { fundId: "f1", exDate: "2026-01-01", amount: 3, tag: "c" },
  ];
  const result = dedupBatchByFundExDate(input, keyOf);
  assert.equal(result.toWrite.length, 0);
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].count, 3);
});

test("dedupBatchByFundExDate: empty input", () => {
  const result = dedupBatchByFundExDate([] as C[], keyOf);
  assert.equal(result.toWrite.length, 0);
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.conflicts.length, 0);
});

test("isMissingUniqueConstraintError: matches by error.code 42P10", () => {
  assert.equal(isMissingUniqueConstraintError({ code: "42P10" }), true);
});

test("isMissingUniqueConstraintError: matches by message text when code is absent", () => {
  assert.equal(isMissingUniqueConstraintError(new Error("no unique or exclusion constraint matching the ON CONFLICT specification")), true);
});

test("isMissingUniqueConstraintError: a generic error does not match", () => {
  assert.equal(isMissingUniqueConstraintError(new Error("connection reset")), false);
  assert.equal(isMissingUniqueConstraintError({ code: "23505" }), false);
});
