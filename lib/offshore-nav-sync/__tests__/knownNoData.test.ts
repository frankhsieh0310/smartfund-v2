import assert from "node:assert/strict";
import { isOnCooldown } from "../knownNoData.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

test("isOnCooldown: never checked -> not on cooldown", () => {
  assert.equal(isOnCooldown("f1", new Map(), new Date("2026-10-12")), false);
});

test("isOnCooldown: checked 1 day ago -> on cooldown", () => {
  const map = new Map([["f1", "2026-10-11T00:00:00.000Z"]]);
  assert.equal(isOnCooldown("f1", map, new Date("2026-10-12T00:00:00.000Z")), true);
});

test("isOnCooldown: checked exactly 7 days ago -> cooldown expired", () => {
  const map = new Map([["f1", "2026-10-05T00:00:00.000Z"]]);
  assert.equal(isOnCooldown("f1", map, new Date("2026-10-12T00:00:00.000Z")), false);
});

test("isOnCooldown: checked 8 days ago -> cooldown expired", () => {
  const map = new Map([["f1", "2026-10-04T00:00:00.000Z"]]);
  assert.equal(isOnCooldown("f1", map, new Date("2026-10-12T00:00:00.000Z")), false);
});
