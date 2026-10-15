import assert from "node:assert/strict";
import { isNewListingSyncWriteEnabled } from "../newListingWriteGate.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const ORIGINAL = process.env.NEW_LISTING_SYNC_WRITE;
function restore() {
  if (ORIGINAL === undefined) delete process.env.NEW_LISTING_SYNC_WRITE;
  else process.env.NEW_LISTING_SYNC_WRITE = ORIGINAL;
}

test("unset (the default) -> shadow mode, write disabled", () => {
  delete process.env.NEW_LISTING_SYNC_WRITE;
  assert.equal(isNewListingSyncWriteEnabled(), false);
  restore();
});

test('exactly "on" -> write enabled', () => {
  process.env.NEW_LISTING_SYNC_WRITE = "on";
  assert.equal(isNewListingSyncWriteEnabled(), true);
  restore();
});

test("near-miss values never fall open", () => {
  for (const v of ["true", "1", "On", "ON", "yes", " on", "on "]) {
    process.env.NEW_LISTING_SYNC_WRITE = v;
    assert.equal(isNewListingSyncWriteEnabled(), false, `expected shadow mode for NEW_LISTING_SYNC_WRITE=${JSON.stringify(v)}`);
  }
  restore();
});
