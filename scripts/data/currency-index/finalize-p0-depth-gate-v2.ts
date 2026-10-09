import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "../../../prisma/generated/currency-index-client/index.js";

const prisma = new PrismaClient();
const output = resolve("runtime", "currency-index", "p0-depth-gate-v2.json");
const contract = JSON.parse(await readFile(resolve("config", "currency-index-p0-contract.json"), "utf8")) as { profiles: Array<{ symbol: string; licenseStatus: string; status: string }>; canarySymbols: string[] };

try {
  const [coverage, methodology, events, constituents, provenance, history, analytics] = await Promise.all([
    prisma.currencyIndexCoverage.findMany({ orderBy: { symbol: "asc" } }),
    prisma.currencyIndexMethodology.findMany({ select: { symbol: true, verificationStatus: true } }),
    prisma.currencyIndexEvent.count(),
    prisma.currencyIndexConstituent.count(),
    prisma.currencyIndexObservationMeta.groupBy({ by: ["symbol"], where: { qualityStatus: "VALID" }, _count: true }),
    prisma.marketData.groupBy({ by: ["symbol"], where: { symbol: { in: contract.profiles.map((item) => item.symbol) }, close: { gt: 0 } }, _count: true }),
    prisma.currencyIndexAnalytic.groupBy({ by: ["symbol", "metric"], where: { qualityStatus: "VALID" }, _count: true }),
  ]);
  const method = new Set(methodology.filter((item) => item.verificationStatus === "VERIFIED").map((item) => item.symbol));
  const provenanceCount = new Map(provenance.map((item) => [item.symbol, item._count]));
  const historyCount = new Map(history.map((item) => [item.symbol, item._count]));
  const analyticMetrics = new Map<string, string[]>();
  for (const item of analytics) analyticMetrics.set(item.symbol, [...(analyticMetrics.get(item.symbol) ?? []), item.metric]);
  const rows = contract.profiles.map((profile) => {
    const c = coverage.find((item) => item.symbol === profile.symbol)!;
    const licensed = profile.licenseStatus === "LICENSE_REQUIRED";
    const pending = profile.status.includes("SOURCE_PENDING");
    const metrics = analyticMetrics.get(profile.symbol) ?? [];
    const provenanceCovered = (provenanceCount.get(profile.symbol) ?? 0) === (historyCount.get(profile.symbol) ?? 0) && (historyCount.get(profile.symbol) ?? 0) > 0;
    const detailReadiness = pending ? "SOURCE_CONSTRAINED" : licensed ? "LICENSE_CONSTRAINED_READY" : c.currentAvailable && c.historyAvailable && method.has(profile.symbol) && metrics.length > 0 && provenanceCovered ? "READY" : "NOT_READY";
    return {
      symbol: profile.symbol,
      identity_status: "COMPLETE",
      current_status: c.currentAvailable ? "VERIFIED_CURRENT" : licensed ? "LICENSE_PENDING" : pending ? "SOURCE_PENDING_CONFIRMED" : "SOURCE_NOT_AVAILABLE",
      history_status: c.historyAvailable ? "HISTORY_READY" : licensed ? "LICENSE_PENDING" : pending ? "SOURCE_PENDING_CONFIRMED" : "NO_VERIFIED_HISTORY_SOURCE",
      methodology_status: method.has(profile.symbol) ? "VERIFIED_OFFICIAL" : licensed ? "LICENSE_PENDING" : pending ? "SOURCE_PENDING_CONFIRMED" : "PUBLIC_OFFICIAL_PARTIAL",
      basket_status: licensed ? "LICENSE_PENDING" : pending ? "SOURCE_PENDING_CONFIRMED" : "PUBLIC_PARTIAL",
      weight_status: licensed ? "LICENSE_PENDING" : "NO_DATA",
      event_status: licensed ? "LICENSE_PENDING" : pending ? "SOURCE_PENDING_CONFIRMED" : "NO_VERIFIED_EVENT_SOURCE",
      analytics_status: metrics.length > 0 ? "READY" : c.historyAvailable ? "NOT_READY" : licensed ? "LICENSE_PENDING" : "SOURCE_PENDING_CONFIRMED",
      provenance_status: provenanceCovered ? "COMPLETE" : c.historyAvailable ? "PARTIAL_LEGACY_HISTORY" : licensed ? "LICENSE_PENDING" : "SOURCE_PENDING_CONFIRMED",
      license_status: profile.licenseStatus,
      source_constraint_type: licensed ? "LICENSE" : pending ? "SOURCE_DISCOVERY" : "NONE",
      detail_readiness: detailReadiness,
    };
  });
  const sample = rows.slice().sort((a, b) => a.symbol.localeCompare(b.symbol)).slice(0, 10);
  const totalHistory = [...historyCount.values()].reduce((sum, value) => sum + value, 0);
  const totalProvenance = [...provenanceCount.values()].reduce((sum, value) => sum + value, 0);
  const result = {
    generatedAt: new Date().toISOString(),
    rows,
    deterministicSample: sample.map((item) => ({ symbol: item.symbol, readiness: item.detail_readiness })),
    summary: {
      coverageRows: rows.length,
      unknownSourceStates: rows.filter((item) => Object.values(item).some((value) => value === "UNKNOWN")).length,
      validCurrent: rows.filter((item) => item.current_status === "VERIFIED_CURRENT").length,
      historyReady: rows.filter((item) => item.history_status === "HISTORY_READY").length,
      methodologyVerified: rows.filter((item) => item.methodology_status === "VERIFIED_OFFICIAL").length,
      basketVerified: constituents > 0 ? new Set([]).size : 0,
      events,
      provenanceRecords: totalProvenance,
      productionHistoryRecords: totalHistory,
      provenanceCoveragePercent: totalHistory ? Number((totalProvenance / totalHistory * 100).toFixed(4)) : 0,
      performanceEntities: new Set(analytics.filter((item) => item.metric.startsWith("CHANGE_")).map((item) => item.symbol)).size,
      riskEntities: new Set(analytics.filter((item) => item.metric.startsWith("VOLATILITY_") || item.metric.startsWith("MAX_DRAWDOWN_") || item.metric.startsWith("52_WEEK_")).map((item) => item.symbol)).size,
      sampleReady: sample.filter((item) => item.detail_readiness === "READY").length,
      sampleLicenseConstrained: sample.filter((item) => item.detail_readiness === "LICENSE_CONSTRAINED_READY").length,
      sampleSourceConstrained: sample.filter((item) => item.detail_readiness === "SOURCE_CONSTRAINED").length,
      sampleNotReady: sample.filter((item) => item.detail_readiness === "NOT_READY").length,
    },
  };
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`);
  await rename(temporary, output);
  console.log(JSON.stringify(result.summary, null, 2));
} finally {
  await prisma.$disconnect();
}
