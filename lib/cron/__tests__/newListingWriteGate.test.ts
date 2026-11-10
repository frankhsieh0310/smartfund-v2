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
  for (const v of ["true", "1", "On", "ON", "yes"]) {
    process.env.NEW_LISTING_SYNC_WRITE = v;
    assert.equal(isNewListingSyncWriteEnabled(), false, `expected shadow mode for NEW_LISTING_SYNC_WRITE=${JSON.stringify(v)}`);
  }
  restore();
});

// 2026-11-10: 這不是near-miss——全域CLAUDE.md的強制規則（2026-10-25事故後）要求所有「XXX_WRITE
// === "on"」判斷都要先.trim()再比較，就是為了讓PowerShell/Vercel CLI不小心帶出的前後空白不會
// 悄悄讓開關失效。" on"/"on "必須視同"on"、正常開啟，不是異常。
test('surrounding whitespace around "on" is trimmed and still enables (mandatory .trim() rule)', () => {
  for (const v of [" on", "on ", " on "]) {
    process.env.NEW_LISTING_SYNC_WRITE = v;
    assert.equal(isNewListingSyncWriteEnabled(), true, `expected write enabled for NEW_LISTING_SYNC_WRITE=${JSON.stringify(v)}`);
  }
  restore();
});
