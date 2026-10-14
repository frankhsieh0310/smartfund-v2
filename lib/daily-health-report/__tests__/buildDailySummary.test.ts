import assert from "node:assert/strict";
import { buildDailySummary } from "../buildDailySummary.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const cleanPipeline = { jobId: "ETF_RETURNS_SYNC", anomaly: false, anomalyReasons: [], lastError: null, lastStatus: "COMPLETED", errorCount24h: 0, hasRunInLast24h: true, writeErrorCount24h: 0 };
const cleanFreshness = { label: "tw_stock_price", latestDate: "2026-10-14", staleDays: 0, anomaly: false, anomalyReason: null };
const cleanGap = { nullCount: 1, codes: ["00838B"], newCodes: [], knownCodes: ["00838B"], anomaly: false };
const cleanYahooTw = { anomaly: false, mismatches: [], samples: [] };

test("buildDailySummary: a clean day always produces a message (never empty, never silent)", () => {
  const msg = buildDailySummary({ today: "2026-10-14", anomalyCount: 0, pipelineHealth: [cleanPipeline], freshness: [cleanFreshness], etfDataSourceGap: cleanGap, yahooTwCheck: cleanYahooTw });
  assert.ok(msg.length > 0);
  assert.ok(msg.includes("✅"));
  assert.ok(!msg.includes("⚠️"));
  assert.ok(msg.includes("ETF_RETURNS_SYNC: COMPLETED"));
  assert.ok(msg.includes("tw_stock_price: latest=2026-10-14"));
});

test("buildDailySummary: an anomaly day is prefixed with a warning and includes detail", () => {
  const brokenPipeline = { ...cleanPipeline, anomaly: true, anomalyReasons: ["NO_RUN_24H"] };
  const msg = buildDailySummary({ today: "2026-10-14", anomalyCount: 1, pipelineHealth: [brokenPipeline], freshness: [cleanFreshness], etfDataSourceGap: cleanGap, yahooTwCheck: cleanYahooTw });
  assert.ok(msg.startsWith("⚠️"));
  assert.ok(msg.includes("1 anomalies"));
  assert.ok(msg.includes("Anomaly detail:"));
  assert.ok(msg.includes("PIPELINE ETF_RETURNS_SYNC: NO_RUN_24H"));
});

test("buildDailySummary: known data-source gaps never appear as new-anomaly noise on a clean day", () => {
  const msg = buildDailySummary({ today: "2026-10-14", anomalyCount: 0, pipelineHealth: [cleanPipeline], freshness: [cleanFreshness], etfDataSourceGap: cleanGap, yahooTwCheck: cleanYahooTw });
  assert.ok(msg.includes("etf_data_source_gap: 1 NULL"));
  assert.ok(!msg.includes("NEW:"));
});

test("buildDailySummary: a pipeline missing its 24h run is flagged even without other anomalies", () => {
  const missed = { ...cleanPipeline, hasRunInLast24h: false };
  const msg = buildDailySummary({ today: "2026-10-14", anomalyCount: 0, pipelineHealth: [missed], freshness: [cleanFreshness], etfDataSourceGap: cleanGap, yahooTwCheck: cleanYahooTw });
  assert.ok(msg.includes("(no run in 24h)"));
});
