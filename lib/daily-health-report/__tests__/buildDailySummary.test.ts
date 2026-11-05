import assert from "node:assert/strict";
import { buildDailySummary, formatAnomalyDetail } from "../buildDailySummary.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// 2026-11-05（使用者核准，Telegram推送第二版——合併成一則訊息，取代第一版「摘要+即時推送」兩則
// 訊息的設計）：buildDailySummary只接 severitySummary 的三個數字 + blockingAnomalies 明細陣列 +
// 每個fingerprint的連續天數，一次產生完整訊息（不再有獨立的buildPersistingBlockingAlert）。

test("buildDailySummary: BLOCKING=0 時只有一行，不列MINOR/EXTERNAL明細", () => {
  const msg = buildDailySummary({
    today: "2026-11-05",
    severitySummary: { blocking: 0, minor: 7, external: 3 },
    blockingAnomalies: [],
  });
  assert.equal(msg, "✅ 今日無需處理的異常（一般 7 項、外部 3 項）");
});

test("buildDailySummary: BLOCKING>0 時列出每一項明細（附中文說明），MINOR/EXTERNAL只顯示數量，全部繁體中文無英文標題", () => {
  const msg = buildDailySummary({
    today: "2026-11-05",
    severitySummary: { blocking: 2, minor: 5, external: 1 },
    blockingAnomalies: [
      { type: "ETF_DATA_SOURCE_GAP", category: "SYSTEM", newCodes: ["00999Z"] },
      { type: "COVERAGE", category: "SYSTEM", label: "core_universe_fund", reason: "COVERAGE_80.0PCT" },
    ],
  });
  assert.ok(msg.startsWith("🔴 每日健康報告 2026-11-05：2 項需要處理"));
  assert.ok(msg.includes("ETF_DATA_SOURCE_GAP（ETF缺少價格來源）"));
  assert.ok(msg.includes("00999Z"));
  assert.ok(msg.includes("COVERAGE（核心母體覆蓋率異常）(core_universe_fund)"));
  assert.ok(msg.includes("COVERAGE_80.0PCT"));
  assert.ok(msg.includes("一般 5 項、外部 1 項，明細見後台"));
  // MINOR/EXTERNAL的個別項目不應該被展開列出
  assert.ok(!msg.includes("PIPELINE"));
  // 第一天出現不標「已連續N天」
  assert.ok(!msg.includes("已連續"));
});

test("buildDailySummary: 連續多天存在的BLOCKING項目標示「已連續N天」，第一天不標", () => {
  const anomaly = { type: "PIPELINE", category: "SYSTEM", jobId: "SITCA_NAV_SYNC", reasons: ["NO_RUN_24H"] };
  const msgDay1 = buildDailySummary({
    today: "2026-11-05",
    severitySummary: { blocking: 1, minor: 0, external: 0 },
    blockingAnomalies: [anomaly],
    consecutiveDaysByFingerprint: { "PIPELINE:SITCA_NAV_SYNC": 1 },
  });
  assert.ok(!msgDay1.includes("已連續"));

  const msgDay3 = buildDailySummary({
    today: "2026-11-07",
    severitySummary: { blocking: 1, minor: 0, external: 0 },
    blockingAnomalies: [anomaly],
    consecutiveDaysByFingerprint: { "PIPELINE:SITCA_NAV_SYNC": 3 },
  });
  assert.ok(msgDay3.includes("（已連續 3 天）"));
});

test("formatAnomalyDetail: 列表型異常只取前3筆樣本、附總數，避免洗版", () => {
  const line = formatAnomalyDetail({
    type: "MONEYDJ_PARSE_FAILED", category: "SYSTEM", jobId: "CLOUD_MONEYDJ_FUND",
    count: 5, codes: ["A001", "A002", "A003", "A004", "A005"],
  });
  assert.ok(line.includes("MONEYDJ_PARSE_FAILED（持股資料解析失敗）"));
  assert.ok(line.includes("5檔"));
  assert.ok(line.includes("A001, A002, A003"));
  assert.ok(line.includes("等共5筆"));
  assert.ok(!line.includes("A004"));
});

test("buildDailySummary: extraNotices附加在訊息最後面，不計入BLOCKING/MINOR/EXTERNAL任何一級數量", () => {
  const msgClean = buildDailySummary({
    today: "2026-11-05",
    severitySummary: { blocking: 0, minor: 2, external: 1 },
    blockingAnomalies: [],
    extraNotices: ["📄 00992B月報已公布"],
  });
  assert.equal(msgClean, "✅ 今日無需處理的異常（一般 2 項、外部 1 項）\n📄 00992B月報已公布");

  const msgBlocking = buildDailySummary({
    today: "2026-11-05",
    severitySummary: { blocking: 1, minor: 0, external: 0 },
    blockingAnomalies: [{ type: "ETF_DATA_SOURCE_GAP", category: "SYSTEM", newCodes: ["00999Z"] }],
    extraNotices: ["📄 00992B月報已公布"],
  });
  assert.ok(msgBlocking.endsWith("📄 00992B月報已公布"));
  assert.ok(msgBlocking.includes("1 項需要處理"));
});

test("formatAnomalyDetail: 未知type仍然產生一行可讀訊息（標「未分類異常」），不丟例外", () => {
  const line = formatAnomalyDetail({ type: "SOME_FUTURE_TYPE", category: "SYSTEM", reason: "未知原因" });
  assert.ok(line.includes("SOME_FUTURE_TYPE（未分類異常）"));
  assert.ok(line.includes("未知原因"));
});
