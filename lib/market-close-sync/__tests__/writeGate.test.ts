import assert from "node:assert/strict";
import { isWriteEnabled, currentRunMode, writeEnvDiagnostic } from "../writeGate.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const ORIGINAL = process.env.MARKET_CLOSE_SYNC_WRITE;
function restore() {
  if (ORIGINAL === undefined) delete process.env.MARKET_CLOSE_SYNC_WRITE;
  else process.env.MARKET_CLOSE_SYNC_WRITE = ORIGINAL;
}

test("unset (the default) -> shadow mode, write disabled", () => {
  delete process.env.MARKET_CLOSE_SYNC_WRITE;
  assert.equal(isWriteEnabled(), false);
  assert.equal(currentRunMode(), "SHADOW");
  restore();
});

test('exactly "on" -> write enabled', () => {
  process.env.MARKET_CLOSE_SYNC_WRITE = "on";
  assert.equal(isWriteEnabled(), true);
  assert.equal(currentRunMode(), "WRITE");
  restore();
});

test("any other value -> still shadow mode, never falls open on a near-miss", () => {
  for (const v of ["true", "1", "On", "ON", "yes", "enabled"]) {
    process.env.MARKET_CLOSE_SYNC_WRITE = v;
    assert.equal(isWriteEnabled(), false, `expected shadow mode for MARKET_CLOSE_SYNC_WRITE=${JSON.stringify(v)}`);
  }
  restore();
});

// 2026-11-10: 這不是near-miss——全域CLAUDE.md的強制規則（2026-10-25事故後）要求所有「XXX_WRITE
// === "on"」判斷都要先.trim()再比較，就是為了讓PowerShell/Vercel CLI不小心帶出的前後空白不會
// 悄悄讓開關失效。" on"/"on "必須視同"on"、正常開啟，不是異常。
test('surrounding whitespace around "on" is trimmed and still enables (mandatory .trim() rule)', () => {
  for (const v of [" on", "on ", " on "]) {
    process.env.MARKET_CLOSE_SYNC_WRITE = v;
    assert.equal(isWriteEnabled(), true, `expected write enabled for MARKET_CLOSE_SYNC_WRITE=${JSON.stringify(v)}`);
  }
  restore();
});

test("Task W6: writeEnvDiagnostic reports readExactlyOn/envVarPresent independently — a near-miss value is present but not read as on", () => {
  process.env.MARKET_CLOSE_SYNC_WRITE = "true";
  const diag = writeEnvDiagnostic();
  assert.equal(diag.readExactlyOn, false);
  assert.equal(diag.envVarPresent, true);
  restore();
});

test("Task W6: writeEnvDiagnostic — unset means envVarPresent is false too, not just readExactlyOn", () => {
  delete process.env.MARKET_CLOSE_SYNC_WRITE;
  const diag = writeEnvDiagnostic();
  assert.equal(diag.readExactlyOn, false);
  assert.equal(diag.envVarPresent, false);
  restore();
});

test('Task W6: writeEnvDiagnostic — exactly "on" sets both flags true', () => {
  process.env.MARKET_CLOSE_SYNC_WRITE = "on";
  const diag = writeEnvDiagnostic();
  assert.equal(diag.readExactlyOn, true);
  assert.equal(diag.envVarPresent, true);
  restore();
});

console.log("WRITE_GATE_TESTS_DONE");
