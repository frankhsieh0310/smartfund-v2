import { freemem } from "node:os";
import { performance } from "node:perf_hooks";
import { prisma } from "../../lib/prisma.ts";
import { WebDataError, errorResponse } from "../../lib/data-platform/web/errors.ts";
import { getEtfDetail, getEtfHistory, getEtfList } from "../../lib/data-platform/web/etfService.ts";
import { getFundDetail, getFundHistory, getFundList } from "../../lib/data-platform/web/fundService.ts";
import { getFxDetail, getFxHistory, getFxList, searchFx } from "../../lib/data-platform/web/fxService.ts";
import { getIndexDetail, getIndexHistory, getIndexList } from "../../lib/data-platform/web/indexService.ts";
import { getStockDetail, getStockHistory, getStockList } from "../../lib/data-platform/web/stockService.ts";
import type { ServiceResponse } from "../../lib/data-platform/web/types.ts";

type Domain = "INDEX" | "FX" | "STOCK" | "ETF" | "FUND";

function memory() {
  const usage = process.memoryUsage();
  return { rssMb: Number((usage.rss / 1_048_576).toFixed(2)), heapMb: Number((usage.heapUsed / 1_048_576).toFixed(2)) };
}

function verifyContract(response: ServiceResponse<unknown>, paginationRequired: boolean) {
  if (!("data" in response) || !response.meta || !("error" in response)) throw new Error("RESPONSE_CONTRACT_INVALID");
  if (paginationRequired && !response.pagination) throw new Error("PAGINATION_MISSING");
  if (!("freshnessStatus" in response.meta)) throw new Error("FRESHNESS_MISSING");
  if (!response.meta.provenance || !("source" in response.meta.provenance)) throw new Error("PROVENANCE_MISSING");
  const expectedError = errorResponse(new WebDataError("NOT_FOUND", "Canary contract check."));
  if (expectedError.status !== 404 || expectedError.body.error?.code !== "NOT_FOUND") throw new Error("ERROR_CONTRACT_INVALID");
}

async function runDomain(domain: Domain) {
  global.gc?.();
  const before = memory();
  const started = performance.now();
  let symbol = "NO_ROW";
  let freshness = "UNKNOWN";
  let provenance: string | null = null;

  if (domain === "INDEX") {
    const list = await getIndexList({ page: 1, pageSize: 1 });
    verifyContract(list, true);
    symbol = list.data?.[0]?.identity.symbol ?? "NO_ROW";
    if (symbol !== "NO_ROW") {
      verifyContract(await getIndexDetail(symbol), false);
      verifyContract(await getIndexHistory(symbol, { page: 1, pageSize: 1 }), true);
    }
    freshness = list.meta.freshnessStatus;
    provenance = list.meta.provenance.source;
  } else if (domain === "FX") {
    const list = await getFxList({ page: 1, pageSize: 1 });
    verifyContract(list, true);
    symbol = list.data?.[0]?.identity.symbol ?? "NO_ROW";
    if (symbol !== "NO_ROW") {
      verifyContract(await searchFx(symbol, { page: 1, pageSize: 1 }), true);
      verifyContract(await getFxDetail(symbol), false);
      verifyContract(await getFxHistory(symbol, { page: 1, pageSize: 1 }), true);
    }
    freshness = list.meta.freshnessStatus;
    provenance = list.meta.provenance.source;
  } else if (domain === "STOCK") {
    const list = await getStockList({ page: 1, pageSize: 1 });
    verifyContract(list, true);
    symbol = list.data?.[0]?.identity.symbol ?? "NO_ROW";
    if (symbol !== "NO_ROW") {
      verifyContract(await getStockDetail(symbol), false);
      verifyContract(await getStockHistory(symbol, { page: 1, pageSize: 5 }), true);
    }
    freshness = list.meta.freshnessStatus;
    provenance = list.meta.provenance.source;
  } else if (domain === "ETF") {
    const list = await getEtfList({ page: 1, pageSize: 1 });
    verifyContract(list, true);
    symbol = list.data?.[0]?.identity.symbol ?? "NO_ROW";
    if (symbol !== "NO_ROW") {
      verifyContract(await getEtfDetail(symbol), false);
      verifyContract(await getEtfHistory(symbol, { page: 1, pageSize: 5 }), true);
    }
    freshness = list.meta.freshnessStatus;
    provenance = list.meta.provenance.source;
  } else {
    const list = await getFundList({ page: 1, pageSize: 1 });
    verifyContract(list, true);
    symbol = list.data?.[0]?.identity.symbol ?? "NO_ROW";
    if (symbol !== "NO_ROW") {
      verifyContract(await getFundDetail(symbol, 1), false);
      verifyContract(await getFundHistory(symbol, { page: 1, pageSize: 5 }), true);
    }
    freshness = list.meta.freshnessStatus;
    provenance = list.meta.provenance.source;
  }

  global.gc?.();
  const after = memory();
  return { domain, querySize: domain === "INDEX" || domain === "FX" ? "LIST_1/DETAIL_1/HISTORY_1" : "LIST_1/DETAIL_1/HISTORY_5", symbol, canonicalRead: symbol === "NO_ROW" ? "NO_CANONICAL_ROW" : "PASS", responseContract: "PASS", pagination: "PASS", freshness, provenance: provenance ?? "NULL_ALLOWED", rssBeforeMb: before.rssMb, rssAfterMb: after.rssMb, heapUsedBeforeMb: before.heapMb, heapUsedAfterMb: after.heapMb, queryDurationMs: Math.round(performance.now() - started), status: symbol === "NO_ROW" ? "NO_CANONICAL_ROW" : "PASS" };
}

console.log(JSON.stringify({ kind: "ENVIRONMENT", nodeVersion: process.version, availableMemoryMb: Math.round(freemem() / 1_048_576), memory: memory() }));
try {
  const requestedDomain = process.argv.find((argument) => argument.startsWith("--domain="))?.split("=")[1]?.toUpperCase();
  const domains = requestedDomain ? [requestedDomain as Domain] : ["INDEX", "FX", "STOCK", "ETF", "FUND"] as const;
  for (const domain of domains) {
    const failureBefore = memory();
    const failureStarted = performance.now();
    try {
      console.log(JSON.stringify(await runDomain(domain)));
    } catch (error) {
      const failureAfter = memory();
      console.log(JSON.stringify({ domain, status: "FAIL", error: error instanceof Error ? error.message : String(error), rssBeforeMb: failureBefore.rssMb, rssAfterMb: failureAfter.rssMb, heapUsedBeforeMb: failureBefore.heapMb, heapUsedAfterMb: failureAfter.heapMb, queryDurationMs: Math.round(performance.now() - failureStarted) }));
    }
  }
} finally {
  await prisma.$disconnect();
}
