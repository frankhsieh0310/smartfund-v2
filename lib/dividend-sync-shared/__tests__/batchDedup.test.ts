import assert from "node:assert/strict";
import { dedupBatchByFundRecordExDate, isMissingUniqueConstraintError } from "../batchDedup.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

type C = { fundId: string; recordDate: string; exDate: string; amount: number; tag: string };
const keyOf = (c: C) => ({ fundId: c.fundId, recordDate: c.recordDate, exDate: c.exDate, amount: c.amount });

test("dedupBatchByFundRecordExDate: no collisions -> everything passes through unchanged", () => {
  const input: C[] = [
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 1, tag: "a" },
    { fundId: "f2", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 1, tag: "b" },
  ];
  const result = dedupBatchByFundRecordExDate(input, keyOf);
  assert.equal(result.toWrite.length, 2);
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.conflicts.length, 0);
});

test("dedupBatchByFundRecordExDate: same key + same amount -> collapses to the LAST occurrence", () => {
  const input: C[] = [
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 1, tag: "first" },
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 1, tag: "second" },
  ];
  const result = dedupBatchByFundRecordExDate(input, keyOf);
  assert.equal(result.toWrite.length, 1);
  assert.equal((result.toWrite[0] as C).tag, "second");
  assert.equal(result.duplicatesCollapsed, 1);
  assert.equal(result.conflicts.length, 0);
});

test("dedupBatchByFundRecordExDate: 3-way same-key same-amount collapses to one, collapsed count is 2", () => {
  const input: C[] = [
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 1, tag: "a" },
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 1, tag: "b" },
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 1, tag: "c" },
  ];
  const result = dedupBatchByFundRecordExDate(input, keyOf);
  assert.equal(result.toWrite.length, 1);
  assert.equal(result.duplicatesCollapsed, 2);
});

test("dedupBatchByFundRecordExDate: same key + different amount -> excluded entirely, reported as a conflict", () => {
  const input: C[] = [
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 1, tag: "a" },
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 2, tag: "b" },
  ];
  const result = dedupBatchByFundRecordExDate(input, keyOf);
  assert.equal(result.toWrite.length, 0);
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].fundId, "f1");
  assert.equal(result.conflicts[0].recordDate, "2026-01-01");
  assert.equal(result.conflicts[0].exDate, "2026-01-08");
  assert.deepEqual(result.conflicts[0].amounts.slice().sort(), [1, 2]);
  assert.equal(result.conflicts[0].count, 2);
});

test("dedupBatchByFundRecordExDate: a conflicting group never leaks into duplicatesCollapsed", () => {
  const input: C[] = [
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 1, tag: "a" },
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 2, tag: "b" },
    { fundId: "f1", recordDate: "2026-01-01", exDate: "2026-01-08", amount: 3, tag: "c" },
  ];
  const result = dedupBatchByFundRecordExDate(input, keyOf);
  assert.equal(result.toWrite.length, 0);
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].count, 3);
});

// This is the 88315292B/D regression case: same fundId AND same exDate, but a DIFFERENT recordDate
// (基準日) -- two genuinely independent distributions that must both survive, not collide.
test("dedupBatchByFundRecordExDate: same fundId+exDate but different recordDate -> NOT grouped, both written", () => {
  const input: C[] = [
    { fundId: "88315292B", recordDate: "2024-03-01", exDate: "2024-03-04", amount: 0.10147, tag: "march-event" },
    { fundId: "88315292B", recordDate: "2024-04-01", exDate: "2024-03-04", amount: 0.09417, tag: "april-event" },
  ];
  const result = dedupBatchByFundRecordExDate(input, keyOf);
  assert.equal(result.toWrite.length, 2);
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.conflicts.length, 0);
});

test("dedupBatchByFundRecordExDate: empty input", () => {
  const result = dedupBatchByFundRecordExDate([] as C[], keyOf);
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
