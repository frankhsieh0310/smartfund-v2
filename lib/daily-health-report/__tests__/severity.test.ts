import assert from "node:assert/strict";
import { anomalyFingerprint } from "../severity.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// 2026-11-05（使用者核准，Telegram推送改版）：anomalyFingerprint是「今天的BLOCKING」跟「昨天存檔
// 的BLOCKING」比對是否為同一個問題的唯一依據，必須對同一個問題（不看清單內個別項目差異）每天都
// 算出同一個字串，否則persisting判斷永遠比對不到。

test("anomalyFingerprint: 有jobId時用type:jobId", () => {
  assert.equal(anomalyFingerprint({ type: "PIPELINE", jobId: "SITCA_NAV_SYNC" }), "PIPELINE:SITCA_NAV_SYNC");
});

test("anomalyFingerprint: 沒jobId但有label時用type:label", () => {
  assert.equal(anomalyFingerprint({ type: "COVERAGE", label: "core_universe_fund" }), "COVERAGE:core_universe_fund");
});

test("anomalyFingerprint: 都沒有時只用type", () => {
  assert.equal(anomalyFingerprint({ type: "ETF_DATA_SOURCE_GAP" }), "ETF_DATA_SOURCE_GAP");
});

test("anomalyFingerprint: 同一個問題的清單內容變了（例如MONEYDJ_PARSE_FAILED今天少了一檔），fingerprint仍然相同", () => {
  const yesterday = anomalyFingerprint({ type: "MONEYDJ_PARSE_FAILED", jobId: "CLOUD_MONEYDJ_FUND" });
  const today = anomalyFingerprint({ type: "MONEYDJ_PARSE_FAILED", jobId: "CLOUD_MONEYDJ_FUND" });
  assert.equal(yesterday, today);
});

test("anomalyFingerprint: 不同jobId的同一個type是不同問題", () => {
  const a = anomalyFingerprint({ type: "PIPELINE", jobId: "SITCA_NAV_SYNC" });
  const b = anomalyFingerprint({ type: "PIPELINE", jobId: "CLOUD_MONEYDJ_FUND" });
  assert.notEqual(a, b);
});
