import assert from "node:assert/strict";
import { parseCommand } from "../commands.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test("parseCommand: /reports and /pending take no args", () => {
  assert.deepEqual(parseCommand("/reports"), { kind: "reports" });
  assert.deepEqual(parseCommand("/pending"), { kind: "pending" });
});

test("parseCommand: /approve and /reject require a postId", () => {
  assert.deepEqual(parseCommand("/approve abc-123"), { kind: "approve", postId: "abc-123" });
  assert.deepEqual(parseCommand("/reject abc-123"), { kind: "reject", postId: "abc-123" });
  assert.equal(parseCommand("/approve").kind, "unknown");
});

test("parseCommand: /hide executes immediately (no confirm step)", () => {
  assert.deepEqual(parseCommand("/hide POST p1"), { kind: "hide", targetType: "POST", targetId: "p1" });
  assert.deepEqual(parseCommand("/hide reply r1"), { kind: "hide", targetType: "REPLY", targetId: "r1" });
});

test("parseCommand: /delete produces a delete_request (confirmation), not an immediate action", () => {
  assert.deepEqual(parseCommand("/delete POST p1"), { kind: "delete_request", targetType: "POST", targetId: "p1" });
});

test("parseCommand: suspend variants map to the right duration", () => {
  assert.deepEqual(parseCommand("/suspend1d u1"), { kind: "suspend_request", profileId: "u1", duration: "1D" });
  assert.deepEqual(parseCommand("/suspend7d u1"), { kind: "suspend_request", profileId: "u1", duration: "7D" });
  assert.deepEqual(parseCommand("/suspend30d u1"), { kind: "suspend_request", profileId: "u1", duration: "30D" });
});

test("parseCommand: /ban produces a ban_request (confirmation)", () => {
  assert.deepEqual(parseCommand("/ban u1"), { kind: "ban_request", profileId: "u1" });
});

test("parseCommand: an unrecognized command falls back to unknown", () => {
  assert.equal(parseCommand("/whatever").kind, "unknown");
  assert.equal(parseCommand("not a command at all").kind, "unknown");
});
