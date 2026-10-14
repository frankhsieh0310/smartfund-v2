import assert from "node:assert/strict";
import { isIndexSyncWriteEnabled } from "../indexWriteGate.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const ORIGINAL = process.env.INDEX_SYNC_WRITE;
function restore() {
  if (ORIGINAL === undefined) delete process.env.INDEX_SYNC_WRITE;
  else process.env.INDEX_SYNC_WRITE = ORIGINAL;
}

test("unset (the default) -> shadow mode, write disabled", () => {
  delete process.env.INDEX_SYNC_WRITE;
  assert.equal(isIndexSyncWriteEnabled(), false);
  restore();
});

test('exactly "on" -> write enabled', () => {
  process.env.INDEX_SYNC_WRITE = "on";
  assert.equal(isIndexSyncWriteEnabled(), true);
  restore();
});

test("any other value -> still shadow mode, never falls open on a near-miss", () => {
  for (const v of ["true", "1", "On", "ON", "yes", " on", "on "]) {
    process.env.INDEX_SYNC_WRITE = v;
    assert.equal(isIndexSyncWriteEnabled(), false, `expected shadow mode for INDEX_SYNC_WRITE=${JSON.stringify(v)}`);
  }
  restore();
});
