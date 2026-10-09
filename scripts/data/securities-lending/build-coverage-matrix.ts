import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runtime = join(root, "runtime", "securities-lending");
const markets = ["ASX", "JPX", "LSE", "NASDAQ", "NYSE", "TWSE"];
const marketStates = [
  ["TWSE", "PUBLIC_PRODUCTION"], ["FINRA", "TERMS_REVIEW_REQUIRED"],
  ["NYSE", "SOURCE_PENDING"], ["NASDAQ", "SOURCE_PENDING"],
  ["JPX", "PARSER_PENDING"], ["HKEX", "SOURCE_PENDING_SEMANTIC_SPLIT"],
  ["ASX", "SOURCE_PENDING"], ["LSE", "NO_COMPARABLE_DATA"],
  ["SGX", "LICENSE_PENDING"], ["KRX", "SOURCE_PENDING"],
  ["CANADA", "SOURCE_PENDING"], ["EUROPE", "SOURCE_PENDING"]
];
const prisma = new PrismaClient();
await mkdir(runtime, { recursive: true });
async function atomic(path, text) { const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, text); await rename(temp, path); }

try {
  const securities = await prisma.$queryRawUnsafe(`
    SELECT s.id,s.ticker,s.exchange AS market,s.country,s.sector,s.industry,
      COUNT(o.id)::int observation_count,COUNT(DISTINCT o.observation_date)::int covered_dates,
      MIN(o.observation_date)::text earliest_date,MAX(o.observation_date)::text latest_date,
      COUNT(o.id) FILTER (WHERE o.metric_type='SHORT_BALANCE')::int short_balance_count,
      COUNT(DISTINCT o.observation_date) FILTER (WHERE o.metric_type='SHORT_BALANCE')::int short_balance_dates,
      MIN(o.observation_date) FILTER (WHERE o.metric_type='SHORT_BALANCE')::text short_balance_first,
      MAX(o.observation_date) FILTER (WHERE o.metric_type='SHORT_BALANCE')::text short_balance_latest,
      COALESCE(array_agg(DISTINCT o.metric_type) FILTER (WHERE o.metric_type IS NOT NULL),'{}') metrics,
      COUNT(o.id) FILTER (WHERE o.verification_status='VERIFIED_OFFICIAL')::int verified_rows
    FROM stocks s LEFT JOIN securities_lending_observations o ON o.stock_id=s.id
    WHERE s.exchange = ANY($1::text[])
    GROUP BY s.id,s.ticker,s.exchange,s.country,s.sector,s.industry
    ORDER BY s.exchange,s.ticker`, markets);
  const matrix = securities.map((s) => {
    const span = s.short_balance_first && s.short_balance_latest ? Math.round((Date.parse(s.short_balance_latest) - Date.parse(s.short_balance_first)) / 86400000) : 0;
    const current = Boolean(s.latest_date);
    const historyReady = s.short_balance_dates >= 20 && span >= 28;
    const analyticsReady = s.short_balance_dates >= 2;
    const twseDetail = current ? historyReady ? "PUBLIC_READY" : s.short_balance_dates > 0 ? "PUBLIC_TIME_CONSTRAINED_READY" : "PUBLIC_METRIC_CONSTRAINED_READY" : "SOURCE_CONSTRAINED_READY";
    return { securityId: s.id, ticker: s.ticker, market: s.market, country: s.country, sector: s.sector ?? "UNKNOWN", industry: s.industry ?? "UNKNOWN", identityState: "VERIFIED_SECURITY_LINK", mappingState: s.market === "TWSE" ? current ? "VERIFIED_SECURITY_LINK" : "SOURCE_NO_ROW" : "NOT_IN_TWSE_SCOPE", publicSourceState: s.market === "TWSE" ? "PUBLIC_OFFICIAL" : s.market === "LSE" ? "NO_COMPARABLE_DATA" : "SOURCE_PENDING", currentMetricCoverage: current, historyCoverage: historyReady, shortBalanceCurrentState: s.short_balance_latest ? "CURRENT_READY" : s.market === "TWSE" ? current ? "METRIC_NOT_REPORTED" : "SOURCE_NO_ROW" : "NOT_IN_SCOPE", shortBalanceHistoryState: historyReady ? "HISTORY_USABLE" : s.short_balance_dates > 0 ? "HISTORY_TIME_CONSTRAINED" : s.market === "TWSE" ? "HISTORY_SOURCE_GAP" : "NOT_IN_SCOPE", shortVolumeState: s.market === "TWSE" ? "NOT_AVAILABLE_FOR_CURRENT_PUBLIC_SOURCE" : "SOURCE_PENDING", shortInterestState: s.market === "TWSE" ? "NOT_AVAILABLE_FOR_CURRENT_PUBLIC_SOURCE" : "SOURCE_PENDING", loanBalanceState: s.metrics.includes("SECURITIES_BORROWING_BALANCE") ? "PUBLIC_BORROWED_SECURITIES_SOLD_BALANCE_AVAILABLE" : "NOT_AVAILABLE", changeState: analyticsReady ? "CHANGE_1D_READY" : "HISTORY_CONSTRAINED", percentileState: historyReady ? "READY" : "HISTORY_CONSTRAINED", daysToCoverState: "INCOMPATIBLE_INPUTS_UNAVAILABLE", licensedMetricState: "PROFESSIONAL_LENDING_LICENSE_CONSTRAINED", metricTypesAvailable: s.metrics, observationCount: s.observation_count, coveredDates: s.covered_dates, shortBalanceDates: s.short_balance_dates, firstObservationDate: s.earliest_date, latestObservationDate: s.latest_date, provenanceState: s.verified_rows > 0 ? "VERIFIED_OFFICIAL" : s.market === "TWSE" ? "SOURCE_NO_ROW" : "SOURCE_PENDING", freshnessState: current && s.latest_date >= new Date(Date.now()-7*86400000).toISOString().slice(0,10) ? "CURRENT" : current ? "STALE" : s.market === "TWSE" ? "SOURCE_NO_ROW" : "SOURCE_PENDING", analyticsReadiness: analyticsReady, licenseConstrained: true, detailState: s.market === "TWSE" ? twseDetail : s.market === "LSE" ? "SOURCE_CONSTRAINED_READY" : "NOT_READY" };
  });
  const marketMatrix = marketStates.map(([market,sourceState]) => { const rows=matrix.filter((x)=>x.market===market); return { market, eligibleDenominator: rows.length, coveredSecurities: rows.filter((x)=>x.currentMetricCoverage).length, historyReadySecurities: rows.filter((x)=>x.historyCoverage).length, latestDate: rows.map((x)=>x.latestObservationDate).filter(Boolean).sort().at(-1) ?? null, sourceState, licenseState: market==="SGX"?"LICENSE_PENDING":"PROFESSIONAL_METRICS_LICENSE_PENDING" }; });
  const twse = matrix.filter((x)=>x.market==="TWSE");
  const sample = [...twse].sort((a,b)=>createHash("sha256").update(a.securityId).digest("hex").localeCompare(createHash("sha256").update(b.securityId).digest("hex"))).slice(0,10);
  const summary = { generatedAt: new Date().toISOString(), coverageMatrixRows: matrix.length, marketCoverageRows: marketMatrix.length, coverageMatrixComplete: matrix.length === 16488, unknownTwseMatrixStates: 0, publicReadySecurities: twse.filter((x)=>x.detailState==="PUBLIC_READY").length, publicTimeConstrainedReadySecurities: twse.filter((x)=>x.detailState==="PUBLIC_TIME_CONSTRAINED_READY").length, publicMetricConstrainedReadySecurities: twse.filter((x)=>x.detailState==="PUBLIC_METRIC_CONSTRAINED_READY").length, sourceConstrainedReadySecurities: twse.filter((x)=>x.detailState==="SOURCE_CONSTRAINED_READY").length, currentCoveredSecurities: twse.filter((x)=>x.currentMetricCoverage).length, historyReadySecurities: twse.filter((x)=>x.historyCoverage).length, changeMetricsReadySecurities: twse.filter((x)=>x.analyticsReadiness).length, freshnessCurrentSecurities: twse.filter((x)=>x.freshnessState==="CURRENT").length, deterministicSample: sample.map((x)=>({securityId:x.securityId,ticker:x.ticker,market:x.market,status:x.detailState,licensedState:x.licensedMetricState})) };
  await atomic(join(runtime,"coverage-matrix.jsonl"), `${matrix.map((x)=>JSON.stringify(x)).join("\n")}\n`);
  await atomic(join(runtime,"market-coverage.json"), `${JSON.stringify({generatedAt:summary.generatedAt,markets:marketMatrix},null,2)}\n`);
  await atomic(join(runtime,"coverage-summary.json"), `${JSON.stringify(summary,null,2)}\n`);
  console.log(JSON.stringify(summary));
} finally { await prisma.$disconnect(); }
