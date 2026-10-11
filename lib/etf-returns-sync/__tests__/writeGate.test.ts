import assert from "node:assert/strict";
import { isWriteEnabled, currentRunMode, writeEnvDiagnostic } from "../writeGate.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const ORIGINAL = process.env.ETF_RETURNS_SYNC_WRITE;
function restore() {
  if (ORIGINAL === undefined) delete process.env.ETF_RETURNS_SYNC_WRITE;
  else process.env.ETF_RETURNS_SYNC_WRITE = ORIGINAL;
}

test("unset (the default) -> shadow mode, write disabled", () => {
  delete process.env.ETF_RETURNS_SYNC_WRITE;
  assert.equal(isWriteEnabled(), false);
  assert.equal(currentRunMode(), "SHADOW");
  restore();
});

test('exactly "on" -> write enabled', () => {
  process.env.ETF_RETURNS_SYNC_WRITE = "on";
  assert.equal(isWriteEnabled(), true);
  assert.equal(currentRunMode(), "WRITE");
  restore();
});

test("any other value -> still shadow mode, never falls open on a near-miss", () => {
  for (const v of ["true", "1", "On", "ON", "yes", " on", "on "]) {
    process.env.ETF_RETURNS_SYNC_WRITE = v;
    assert.equal(isWriteEnabled(), false, `expected shadow mode for ETF_RETURNS_SYNC_WRITE=${JSON.stringify(v)}`);
  }
  restore();
});

test("independent of MARKET_CLOSE_SYNC_WRITE — the two pipelines' write switches never interact", () => {
  process.env.MARKET_CLOSE_SYNC_WRITE = "on";
  delete process.env.ETF_RETURNS_SYNC_WRITE;
  assert.equal(isWriteEnabled(), false);
  delete process.env.MARKET_CLOSE_SYNC_WRITE;
});

test("writeEnvDiagnostic distinguishes present-but-wrong from absent", () => {
  process.env.ETF_RETURNS_SYNC_WRITE = "true";
  let diag = writeEnvDiagnostic();
  assert.equal(diag.readExactlyOn, false);
  assert.equal(diag.envVarPresent, true);
  delete process.env.ETF_RETURNS_SYNC_WRITE;
  diag = writeEnvDiagnostic();
  assert.equal(diag.envVarPresent, false);
  restore();
});

console.log("ETF_RETURNS_WRITE_GATE_TESTS_DONE");
