import assert from "node:assert/strict";
import { decideWriteProbeNotification } from "../writeProbeIncident.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const now = new Date("2026-11-05T10:00:00Z");

test("decideWriteProbeNotification: 第一次失敗（前一筆是COMPLETED）一定推送", () => {
  const d = decideWriteProbeNotification([{ status: "COMPLETED", startedAt: "2026-11-05T09:45:00Z" }], now);
  assert.equal(d.isNewIncident, true);
  assert.equal(d.shouldNotify, true);
  assert.equal(d.reminderSentToWrite, false);
});

test("decideWriteProbeNotification: 第一次失敗（完全沒有歷史紀錄）一定推送", () => {
  const d = decideWriteProbeNotification([], now);
  assert.equal(d.isNewIncident, true);
  assert.equal(d.shouldNotify, true);
});

test("decideWriteProbeNotification: 持續故障但未滿1小時，不重複推送", () => {
  const d = decideWriteProbeNotification([
    { status: "FAILED", startedAt: "2026-11-05T09:45:00Z" }, // 15分鐘前，同一個incident的開始
    { status: "COMPLETED", startedAt: "2026-11-05T09:30:00Z" },
  ], now);
  assert.equal(d.isNewIncident, false);
  assert.equal(d.shouldNotify, false);
});

test("decideWriteProbeNotification: 持續故障滿1小時且還沒提醒過，推送一次提醒", () => {
  const d = decideWriteProbeNotification([
    { status: "FAILED", startedAt: "2026-11-05T09:45:00Z" },
    { status: "FAILED", startedAt: "2026-11-05T09:30:00Z" },
    { status: "FAILED", startedAt: "2026-11-05T09:00:00Z" }, // incident從9:00開始，距今剛好1小時
    { status: "COMPLETED", startedAt: "2026-11-05T08:45:00Z" },
  ], now);
  assert.equal(d.isNewIncident, false);
  assert.equal(d.shouldNotify, true);
  assert.equal(d.reminderSentToWrite, true);
  assert.equal(d.incidentStartedAt.toISOString(), "2026-11-05T09:00:00.000Z");
});

test("decideWriteProbeNotification: 已經提醒過一次的話，即使還在故障、超過1小時也不再推送（最多再提醒一次）", () => {
  const d = decideWriteProbeNotification([
    { status: "FAILED", startedAt: "2026-11-05T09:45:00Z", reminderSent: true },
    { status: "FAILED", startedAt: "2026-11-05T08:00:00Z" }, // incident從8:00開始，已經超過1小時很多
    { status: "COMPLETED", startedAt: "2026-11-05T07:45:00Z" },
  ], now);
  assert.equal(d.isNewIncident, false);
  assert.equal(d.reminderAlreadySent, true);
  assert.equal(d.shouldNotify, false);
});

test("decideWriteProbeNotification: 恢復後再次失敗，視為新的incident（不受上一次incident的reminder_sent影響）", () => {
  const d = decideWriteProbeNotification([
    { status: "COMPLETED", startedAt: "2026-11-05T09:55:00Z" }, // 剛恢復過
    { status: "FAILED", startedAt: "2026-11-05T08:00:00Z", reminderSent: true }, // 上一次incident，已經提醒過
  ], now);
  assert.equal(d.isNewIncident, true);
  assert.equal(d.shouldNotify, true);
});
