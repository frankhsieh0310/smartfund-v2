import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "../../../prisma/generated/currency-index-client/index.js";

const prisma = new PrismaClient();
const runtime = resolve("runtime", "currency-index");
const contract = JSON.parse(await readFile(resolve("config", "currency-index-p0-contract.json"), "utf8")) as { profiles: Array<{ symbol: string; status: string; licenseStatus: string; methodologyUrl: string | null; sourceAdapter: string }> };
const legacy = JSON.parse(await readFile(resolve(runtime, "checkpoint.json"), "utf8")) as { deadLetter: Array<{ asset: string; interval: string; stage: string; error: string }> };
const intraday = new Set(["1m", "5m", "15m", "30m", "60m", "4h"]);
const officialLegacy = new Set(["FED_BROAD_DOLLAR", "FED_TRADE_WEIGHTED_DOLLAR", "BIS_USD_NEER", "BIS_USD_REER"]);

async function atomic(path: string, value: unknown) { const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path); }

try {
  const symbols = contract.profiles.map((item) => item.symbol);
  const [coverage, masters, history, provenance, methodologies, analytics, eventCount] = await Promise.all([
    prisma.currencyIndexCoverage.findMany({ orderBy: { symbol: "asc" } }),
    prisma.marketMaster.findMany({ where: { symbol: { in: symbols } }, select: { symbol: true, latestClose: true, latestDate: true, provider: true } }),
    prisma.marketData.groupBy({ by: ["symbol"], where: { symbol: { in: symbols }, close: { gt: 0 } }, _count: true, _min: { date: true }, _max: { date: true } }),
    prisma.currencyIndexObservationMeta.groupBy({ by: ["symbol"], where: { symbol: { in: symbols }, qualityStatus: "VALID", parserVersion: { not: "UNSPECIFIED" }, checksumStatus: { not: "UNAVAILABLE" } }, _count: true }),
    prisma.currencyIndexMethodology.findMany({ select: { symbol: true, verificationStatus: true } }),
    prisma.currencyIndexAnalytic.groupBy({ by: ["symbol", "metric"], where: { qualityStatus: "VALID" }, _count: true }),
    prisma.currencyIndexEvent.count(),
  ]);
  const byCoverage = new Map(coverage.map((item) => [item.symbol, item]));
  const byMaster = new Map(masters.map((item) => [item.symbol, item]));
  const byHistory = new Map(history.map((item) => [item.symbol, item]));
  const byProvenance = new Map(provenance.map((item) => [item.symbol, item._count]));
  const verifiedMethods = new Set(methodologies.filter((item) => item.verificationStatus === "VERIFIED").map((item) => item.symbol));
  const metrics = new Map<string, string[]>(); for (const item of analytics) metrics.set(item.symbol, [...(metrics.get(item.symbol) ?? []), item.metric]);
  const now = Date.now();
  const rows = contract.profiles.map((profile) => {
    const c = byCoverage.get(profile.symbol)!; const master = byMaster.get(profile.symbol); const h = byHistory.get(profile.symbol); const metricList = metrics.get(profile.symbol) ?? [];
    const licensed = profile.licenseStatus === "LICENSE_REQUIRED"; const sourcePending = profile.status === "SOURCE_PENDING";
    const currentReady = Boolean(master?.latestClose && Number(master.latestClose) > 0 && master.latestDate && c.sourceVerified);
    const historyReady = Boolean(h?._count && c.sourceVerified); const provenanceComplete = historyReady && byProvenance.get(profile.symbol) === h?._count;
    const analyticsReady = historyReady && metricList.length > 0;
    const methodologyState = verifiedMethods.has(profile.symbol) ? "VERIFIED_OFFICIAL" : licensed ? "LICENSE_PENDING" : sourcePending ? "SOURCE_PENDING" : "PUBLIC_PARTIAL";
    const basketState = licensed ? "LICENSE_PENDING" : sourcePending ? "SOURCE_PENDING" : "PUBLIC_PARTIAL";
    const coreState = sourcePending ? "SOURCE_CONSTRAINED_READY" : licensed ? "LICENSE_CONSTRAINED_READY" : currentReady && historyReady && analyticsReady && provenanceComplete && methodologyState === "VERIFIED_OFFICIAL" ? "READY" : "NOT_READY";
    let freshness = sourcePending || licensed && !currentReady ? "SOURCE_CONSTRAINED" : "STALE";
    if (currentReady && master?.latestDate) { const ageDays = Math.floor((now - master.latestDate.getTime()) / 86_400_000); freshness = profile.sourceAdapter === "FRED_CSV" && profile.symbol.startsWith("BIS_") || ["EUR_INDEX", "JPY_INDEX"].includes(profile.symbol) ? ageDays <= 75 ? "WAITING_FOR_NEXT_PUBLICATION" : "STALE" : ageDays <= 3 ? "CURRENT" : ageDays <= 7 ? "MARKET_CLOSED" : "STALE"; }
    return { symbol: profile.symbol, coreState, currentState: currentReady ? "VERIFIED_CURRENT" : sourcePending ? "SOURCE_PENDING" : licensed ? "LICENSE_REQUIRED" : "SOURCE_NOT_AVAILABLE", historyState: historyReady ? "HISTORY_READY" : sourcePending ? "SOURCE_PENDING" : licensed ? "LICENSE_REQUIRED" : "SOURCE_NOT_AVAILABLE", methodologyState, basketState, historicalWeightsState: licensed ? "LICENSE_PENDING" : sourcePending ? "SOURCE_PENDING" : "SOURCE_PENDING", rebalanceEventState: licensed ? "LICENSE_PENDING" : sourcePending ? "SOURCE_PENDING" : "SOURCE_PENDING", analyticsState: analyticsReady ? "READY" : historyReady ? "NOT_READY" : "NOT_APPLICABLE", provenanceState: provenanceComplete ? "COMPLETE" : historyReady ? "INCOMPLETE" : sourcePending ? "SOURCE_PENDING" : "LICENSE_PENDING", freshness, selectionReason: sourcePending ? "AUTHORITATIVE_METHODOLOGY_NOT_FOUND_WITHIN_BOUNDED_DISCOVERY" : licensed ? "PROPRIETARY_LICENSE_BOUNDARY" : "VERIFIED_PUBLIC_SOURCE" };
  });
  const deadLetters = legacy.deadLetter.map((item) => ({ ...item, classification: intraday.has(item.interval) ? "INVALID_STAGE" : officialLegacy.has(item.asset) ? "TRANSIENT_RETRYABLE" : "PERMANENT_SOURCE_FAILURE", replayPolicy: intraday.has(item.interval) ? "QUARANTINE" : officialLegacy.has(item.asset) ? "MANUAL_VERIFIED_ONLY" : "DO_NOT_REPLAY" }));
  const activeRetry = deadLetters.filter((item) => item.classification === "TRANSIENT_RETRYABLE");
  const basketPublicPartial = rows.filter((item) => item.basketState === "PUBLIC_PARTIAL").map((item) => ({ symbol: item.symbol, availableConstituentCount: 0, reportedTotalCount: null, weightCoveragePercent: 0, effectiveDate: null, source: contract.profiles.find((profile) => profile.symbol === item.symbol)?.methodologyUrl, verificationState: "PUBLIC_PARTIAL", partialReason: "Official methodology semantics available; structured constituent and weight dataset unavailable." }));
  const sample = rows.slice().sort((a, b) => a.symbol.localeCompare(b.symbol)).slice(0, 10);
  const canonical = [...byHistory.values()].reduce((sum, item) => sum + item._count, 0); const provenanceCount = [...byProvenance.values()].reduce((sum, value) => sum + value, 0);
  const result = { generatedAt: new Date().toISOString(), rows, basketPublicPartial, freshness: Object.fromEntries(rows.map((item) => [item.symbol, item.freshness])), deterministicSample: sample.map((item) => ({ symbol: item.symbol, readiness: item.coreState })), summary: { totalEntities: rows.length, ready: rows.filter((item) => item.coreState === "READY").length, sourceConstrainedReady: rows.filter((item) => item.coreState === "SOURCE_CONSTRAINED_READY").length, licenseConstrainedReady: rows.filter((item) => item.coreState === "LICENSE_CONSTRAINED_READY").length, notReady: rows.filter((item) => item.coreState === "NOT_READY").length, currentReady: rows.filter((item) => item.currentState === "VERIFIED_CURRENT").length, historyReady: rows.filter((item) => item.historyState === "HISTORY_READY").length, analyticsReady: rows.filter((item) => item.analyticsState === "READY").length, methodologyVerified: rows.filter((item) => item.methodologyState === "VERIFIED_OFFICIAL").length, canonicalObservations: canonical, provenanceRecords: provenanceCount, provenanceCoveragePercent: canonical ? Number((provenanceCount / canonical * 100).toFixed(4)) : 0, basketPublicPartial: basketPublicPartial.length, eventCount, deadLetterTotal: deadLetters.length, deadLetterActiveRetryable: activeRetry.length, deadLetterInvalidStage: deadLetters.filter((item) => item.classification === "INVALID_STAGE").length, deadLetterPermanent: deadLetters.filter((item) => item.classification === "PERMANENT_SOURCE_FAILURE").length, sampleReady: sample.filter((item) => item.coreState === "READY").length, sampleSourceConstrained: sample.filter((item) => item.coreState === "SOURCE_CONSTRAINED_READY").length, sampleLicenseConstrained: sample.filter((item) => item.coreState === "LICENSE_CONSTRAINED_READY").length, sampleNotReady: sample.filter((item) => item.coreState === "NOT_READY").length } };
  await atomic(resolve(runtime, "p0-core-ready-v3.json"), result); await atomic(resolve(runtime, "p0-dead-letter-reconciliation-v3.json"), { generatedAt: new Date().toISOString(), items: deadLetters }); await atomic(resolve(runtime, "p0-active-retry-queue-v3.json"), { generatedAt: new Date().toISOString(), autoReplay: false, items: activeRetry });
  console.log(JSON.stringify(result.summary, null, 2));
} finally { await prisma.$disconnect(); }
