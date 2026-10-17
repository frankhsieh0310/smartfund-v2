// Round-4, user-approved: daily-health-report must send a Telegram summary EVERY day, not only on
// anomaly -- "沒收到訊息就代表出事了" (no message = something's wrong) only works if silence is never
// the normal case. Extracted as a pure function so the message format is unit-testable without a DB.
import type { PipelineHealth, DataFreshnessResult, DataSourceGapResult, YahooTwReturnCheckResult, FredCommodityCheckResult } from "./checks";

export function buildDailySummary(input: {
  today: string;
  anomalyCount: number;
  pipelineHealth: PipelineHealth[];
  freshness: DataFreshnessResult[];
  etfDataSourceGap: DataSourceGapResult;
  yahooTwCheck: YahooTwReturnCheckResult;
  fredCommodityCheck: FredCommodityCheckResult;
}): string {
  const { today, anomalyCount, pipelineHealth, freshness, etfDataSourceGap, yahooTwCheck, fredCommodityCheck } = input;
  const lines: string[] = [];
  lines.push(anomalyCount > 0 ? `⚠️ Daily health report ${today}: ${anomalyCount} anomalies` : `✅ Daily health report ${today}: all clear`);
  for (const p of pipelineHealth) {
    lines.push(`${p.anomaly ? "⚠️" : "•"} ${p.jobId}: ${p.lastStatus ?? "NO_RUN"}${p.hasRunInLast24h ? "" : " (no run in 24h)"}`);
  }
  for (const f of freshness) {
    lines.push(`${f.anomaly ? "⚠️" : "•"} ${f.label}: latest=${f.latestDate ?? "—"} (${f.staleDays ?? "?"}d stale)`);
  }
  lines.push(`• etf_data_source_gap: ${etfDataSourceGap.nullCount} NULL${etfDataSourceGap.newCodes.length ? ` (${etfDataSourceGap.newCodes.length} NEW: ${etfDataSourceGap.newCodes.join(", ")})` : ""}`);
  if (yahooTwCheck.mismatches?.length) lines.push(`• yahoo_tw_return_check: ${yahooTwCheck.mismatches.length} sampled`);
  for (const s of fredCommodityCheck.samples) lines.push(`${fredCommodityCheck.mismatches.some((m) => m.label === s.label) ? "⚠️" : "•"} fred_${s.label.toLowerCase()}: ours=${s.ourClose ?? "—"}(${s.ourDate ?? "—"}) fred=${s.fredValue ?? "—"}(${s.fredDate ?? "—"})`);

  if (anomalyCount > 0) {
    lines.push("");
    lines.push("Anomaly detail:");
    for (const p of pipelineHealth) if (p.anomaly) lines.push(`- PIPELINE ${p.jobId}: ${p.anomalyReasons.join(", ")}`);
    for (const f of freshness) if (f.anomaly) lines.push(`- FRESHNESS ${f.label}: ${f.anomalyReason}`);
    if (etfDataSourceGap.anomaly) lines.push(`- ETF data_source NULL (new, not yet investigated): ${etfDataSourceGap.newCodes.join(", ")}`);
    if (etfDataSourceGap.knownCodes.length > 0) lines.push(`(known/suspected-delisted, not a new warning: ${etfDataSourceGap.knownCodes.join(", ")})`);
    if (yahooTwCheck.anomaly) for (const m of yahooTwCheck.mismatches) lines.push(`- YAHOO_TW_RETURN_MISMATCH ${m.code}: ours=${m.ourReturn1y} yahooTw=${m.yahooTwReturn1y} fetchFailed=${m.fetchFailed}`);
    if (fredCommodityCheck.anomaly) for (const m of fredCommodityCheck.mismatches) lines.push(`- FRED_COMMODITY_MISMATCH ${m.label}: ours=${m.ourClose}(${m.ourDate}) fred=${m.fredValue}(${m.fredDate}) diffPct=${m.diffPct?.toFixed(1) ?? "—"} fetchFailed=${m.fetchFailed}`);
  }
  return lines.join("\n");
}
