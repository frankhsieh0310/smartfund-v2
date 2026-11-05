import assert from "node:assert/strict";
import { anomalyFingerprint, countConsecutiveDays } from "../severity.ts";

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

// 2026-11-05（使用者核准，Telegram推送第二版）：countConsecutiveDays是「已連續N天」標示的唯一依據。
test("countConsecutiveDays: 從沒出現過時回傳1（只算今天）", () => {
  assert.equal(countConsecutiveDays("PIPELINE:X", []), 1);
  assert.equal(countConsecutiveDays("PIPELINE:X", [new Set(["OTHER:Y"])]), 1);
});

test("countConsecutiveDays: 昨天也在，回傳2", () => {
  assert.equal(countConsecutiveDays("PIPELINE:X", [new Set(["PIPELINE:X"])]), 2);
});

test("countConsecutiveDays: 連續3天都在（今天+昨天+前天），第4天（大前天）缺席就停止數", () => {
  const history = [new Set(["PIPELINE:X"]), new Set(["PIPELINE:X"]), new Set<string>()];
  assert.equal(countConsecutiveDays("PIPELINE:X", history), 3);
});

test("countConsecutiveDays: 昨天缺席，即使前天在，也只回傳1（不能跳過缺席那天繼續數）", () => {
  const history = [new Set<string>(), new Set(["PIPELINE:X"])];
  assert.equal(countConsecutiveDays("PIPELINE:X", history), 1);
});
