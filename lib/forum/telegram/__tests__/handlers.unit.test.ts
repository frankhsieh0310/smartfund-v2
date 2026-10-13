// Pure, no-DB tests: confirm that requesting a destructive action (/delete, /suspend*, /ban) only
// ever builds a confirmation message + inline keyboard and never touches the database by itself —
// per the week-1/week-3 rule "刪文與停權需按確認按鈕才執行". DB-touching behavior (what happens once
// the button IS pressed) is covered separately in integration.test.ts.

import assert from "node:assert/strict";
import { buildDeleteConfirmation, buildSuspendConfirmation, buildBanConfirmation } from "../handlers.ts";
import { decodePendingAction } from "../pendingActions.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test("buildDeleteConfirmation: returns a confirm/cancel keyboard, not an executed action", () => {
  const reply = buildDeleteConfirmation("POST", "p1");
  assert.match(reply.text, /確定/);
  assert.equal(reply.inlineKeyboard?.length, 1);
  assert.equal(reply.inlineKeyboard?.[0]?.length, 2);
  const confirmButton = reply.inlineKeyboard![0]![0]!;
  assert.deepEqual(decodePendingAction(confirmButton.callback_data), { kind: "delete", targetType: "POST", targetId: "p1" });
});

test("buildSuspendConfirmation: encodes the requested duration, pending confirmation", () => {
  const reply = buildSuspendConfirmation("profile-1", "7D");
  const confirmButton = reply.inlineKeyboard![0]![0]!;
  assert.deepEqual(decodePendingAction(confirmButton.callback_data), {
    kind: "suspend",
    profileId: "profile-1",
    duration: "7D",
  });
});

test("buildBanConfirmation: pending confirmation for a permanent ban", () => {
  const reply = buildBanConfirmation("profile-1");
  const confirmButton = reply.inlineKeyboard![0]![0]!;
  assert.deepEqual(decodePendingAction(confirmButton.callback_data), { kind: "ban", profileId: "profile-1" });
});

test("every confirmation's second button is the cancel action", () => {
  for (const reply of [buildDeleteConfirmation("POST", "p1"), buildSuspendConfirmation("p1", "1D"), buildBanConfirmation("p1")]) {
    assert.equal(reply.inlineKeyboard![0]![1]!.callback_data, "cancel");
  }
});
