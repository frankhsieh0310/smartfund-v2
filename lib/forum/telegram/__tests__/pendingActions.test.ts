import assert from "node:assert/strict";
import { encodePendingAction, decodePendingAction } from "../pendingActions.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test("encode/decode round-trip for delete", () => {
  const action = { kind: "delete" as const, targetType: "POST" as const, targetId: "abc123" };
  assert.deepEqual(decodePendingAction(encodePendingAction(action)), action);
});

test("encode/decode round-trip for suspend", () => {
  const action = { kind: "suspend" as const, profileId: "p1", duration: "7D" as const };
  assert.deepEqual(decodePendingAction(encodePendingAction(action)), action);
});

test("encode/decode round-trip for ban", () => {
  const action = { kind: "ban" as const, profileId: "p1" };
  assert.deepEqual(decodePendingAction(encodePendingAction(action)), action);
});

test("decodePendingAction: garbage input returns null instead of throwing", () => {
  assert.equal(decodePendingAction("not a real payload"), null);
  assert.equal(decodePendingAction("confirm:nonsense"), null);
});

test("encodePendingAction: stays within Telegram's 64-byte callback_data limit for a realistic uuid", () => {
  const action = { kind: "delete" as const, targetType: "POST" as const, targetId: "123e4567-e89b-12d3-a456-426614174000" };
  const encoded = encodePendingAction(action);
  assert.ok(Buffer.byteLength(encoded, "utf-8") <= 64);
});
