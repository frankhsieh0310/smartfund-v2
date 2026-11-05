import assert from "node:assert/strict";
import { buildDailySummary, buildPersistingBlockingAlert, formatAnomalyDetail } from "../buildDailySummary.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// 2026-11-05（使用者核准，Telegram推送改版）：這份測試取代Round-4版本——新版 buildDailySummary
// 只接 severitySummary 的三個數字 + blockingAnomalies 明細陣列，不再逐一接 pipelineHealth/
// freshness/coverage 等個別檢查陣列（那些現在只影響 anomalies/severitySummary 怎麼算出來，
// 跟訊息排版本身脫鉤）。

test("buildDailySummary: BLOCKING=0 時只有一行，不列MINOR/EXTERNAL明細", () => {
  const msg = buildDailySummary({
    today: "2026-11-05",
    severitySummary: { blocking: 0, minor: 7, external: 3 },
    blockingAnomalies: [],
  });
  assert.equal(msg, "✅ 今日無需處理的異常（一般 7 項、外部 3 項）");
});

test("buildDailySummary: BLOCKING>0 時列出每一項明細，MINOR/EXTERNAL只顯示數量", () => {
  const msg = buildDailySummary({
    today: "2026-11-05",
    severitySummary: { blocking: 2, minor: 5, external: 1 },
    blockingAnomalies: [
      { type: "ETF_DATA_SOURCE_GAP", category: "SYSTEM", newCodes: ["00999Z"] },
      { type: "COVERAGE", category: "SYSTEM", label: "core_universe_fund", reason: "COVERAGE_80.0PCT" },
    ],
  });
  assert.ok(msg.startsWith("🔴 Daily health report 2026-11-05：2 項需要處理"));
  assert.ok(msg.includes("ETF_DATA_SOURCE_GAP"));
  assert.ok(msg.includes("00999Z"));
  assert.ok(msg.includes("COVERAGE (core_universe_fund)"));
  assert.ok(msg.includes("COVERAGE_80.0PCT"));
  assert.ok(msg.includes("一般 5 項、外部 1 項，明細見後台"));
  // MINOR/EXTERNAL的個別項目不應該被展開列出，只有彙總那一行提到「5」「1」
  assert.ok(!msg.includes("PIPELINE"));
});

test("buildPersistingBlockingAlert: 沒有persisting項目時回傳null，不產生空訊息", () => {
  const msg = buildPersistingBlockingAlert("2026-11-05", []);
  assert.equal(msg, null);
});

test("buildPersistingBlockingAlert: 有persisting項目時列出明細，跟daily summary是獨立的字串", () => {
  const msg = buildPersistingBlockingAlert("2026-11-05", [
    { type: "PIPELINE", category: "SYSTEM", jobId: "SITCA_NAV_SYNC", reasons: ["NO_RUN_24H"] },
  ]);
  assert.ok(msg !== null);
  assert.ok(msg!.includes("連續超過一天未解決"));
  assert.ok(msg!.includes("PIPELINE (SITCA_NAV_SYNC)"));
  assert.ok(msg!.includes("NO_RUN_24H"));
});

test("formatAnomalyDetail: 列表型異常只取前3筆樣本、附總數，避免洗版", () => {
  const line = formatAnomalyDetail({
    type: "MONEYDJ_PARSE_FAILED", category: "SYSTEM", jobId: "CLOUD_MONEYDJ_FUND",
    count: 5, codes: ["A001", "A002", "A003", "A004", "A005"],
  });
  assert.ok(line.includes("5檔"));
  assert.ok(line.includes("A001, A002, A003"));
  assert.ok(line.includes("等共5筆"));
  assert.ok(!line.includes("A004"));
});

test("formatAnomalyDetail: 未知type仍然產生一行可讀訊息，不丟例外", () => {
  const line = formatAnomalyDetail({ type: "SOME_FUTURE_TYPE", category: "SYSTEM", reason: "未知原因" });
  assert.ok(line.includes("SOME_FUTURE_TYPE"));
  assert.ok(line.includes("未知原因"));
});
