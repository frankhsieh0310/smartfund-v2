// Alternative-source fund holdings sync (offshore + domestic funds, via Yahoo奇摩基金). Replaces
// nothing yet -- writes to the SAME `holdings` table as the existing MoneyDJ pipeline (lib/cloud-
// ingestion/fundHoldings.ts) but under its own `source` value, so both coexist and can be compared
// before any cutover decision. SHADOW MODE BY DEFAULT: unless HOLDINGS_ALT_SOURCE_WRITE is exactly
// "on", this route fetches/matches but writes nothing (see lib/holdings-alt-source/writeGate.ts).
//
// Two independent mapping sources feed the SAME fetch/write logic (fundId + yahooFundId is all either
// needs): offshore funds use the pre-built offshore-nav-sync:yahoo-mapping checkpoint; domestic funds
// use the existing fund_provider_mappings(provider='yahoo') rows directly (confirmed live: provider_code
// + ":FO" works as a yahooFundId with no new discovery sweep needed -- see domesticYahooMapping.ts).
//
// Selection: oldest-fetched-or-never-fetched first, skipping funds with a REAL (fund_id, source) row in
// `holdings` less than FRESH_DAYS old -- shadow-mode runs never write, so they can never make a fund
// look "already fetched" (see selection.ts). Scheduled hourly at :52 (vercel.json); 150s time budget
// per invocation, picks up where it left off next hour via the same freshness query (no separate
// checkpoint needed -- the `holdings` table rows ARE the checkpoint).
//
// ETF constituent sources: no new work needed, lib/etf-holdings-engine/ already covers this via
// official per-issuer disclosure. SITCA top-10 domestic holdings: researched, not found/implemented
// this round -- see scratch/overnight-report-20261013.md Part 2.
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import { loadDomesticYahooMapping } from "@/lib/holdings-alt-source/domesticYahooMapping";
import { selectOldestFirst } from "@/lib/holdings-alt-source/selection";
import { fetchYahooOffshoreHoldings, YahooRateLimitedError, YAHOO_HOLDINGS_SOURCE } from "@/lib/holdings-alt-source/yahooOffshoreHoldings";
import { writeYahooOffshoreHoldings, type QueryFn } from "@/lib/holdings-alt-source/writer";
import { isWriteEnabled, currentRunMode } from "@/lib/holdings-alt-source/writeGate";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "HOLDINGS_ALT_SOURCE_SYNC";
const TIME_BUDGET_MS = 150_000;
const REQUEST_SPACING_MS = 3_000;
const FRESH_DAYS = 25;
const MAX_CONSECUTIVE_FAILURES = 5;
const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabledThisRun = isWriteEnabled();
  const runKey = `holdings-alt-source-sync:${new Date(startedMs).toISOString()}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: YAHOO_HOLDINGS_SOURCE, runKey, universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present and running", runKey, runMode: currentRunMode() });
  }

  const [offshoreMapping, domesticMapping] = await Promise.all([loadMapping(query), loadDomesticYahooMapping(query)]);
  const combined = [...offshoreMapping, ...domesticMapping];
  const sorted = await selectOldestFirst(query, combined, YAHOO_HOLDINGS_SOURCE, FRESH_DAYS);

  let attempted = 0, fetched = 0, written = 0, writableRowCount = 0, errorCount = 0, rateLimited = false;
  let httpStatus: number | null = null;
  let consecutiveFailures = 0;
  let stoppedReason: string | null = null;
  let offshoreAttempted = 0, offshoreFetched = 0, domesticAttempted = 0, domesticFetched = 0;
  const offshoreFundIds = new Set(offshoreMapping.map((m) => m.fundId));

  for (const entry of sorted) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { stoppedReason = "TIME_BUDGET_EXCEEDED"; break; }
    attempted++;
    const isOffshore = offshoreFundIds.has(entry.fundId);
    if (isOffshore) offshoreAttempted++; else domesticAttempted++;
    try {
      const holdings = await fetchYahooOffshoreHoldings(entry.yahooFundId);
      if (holdings) {
        fetched++;
        if (isOffshore) offshoreFetched++; else domesticFetched++;
        writableRowCount += holdings.holdings.length;
        const result = await writeYahooOffshoreHoldings(query, YAHOO_HOLDINGS_SOURCE, { fundId: entry.fundId, yahooFundId: entry.yahooFundId, holdings }, writeEnabledThisRun);
        written += result.written;
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }
    } catch (e) {
      if (e instanceof YahooRateLimitedError) {
        rateLimited = true;
        httpStatus = e.httpStatus;
        stoppedReason = `RATE_LIMITED_${e.httpStatus}`;
        break;
      }
      errorCount++;
      consecutiveFailures++;
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stoppedReason = `CONSECUTIVE_FAILURES_${consecutiveFailures}`;
      break;
    }
    await sleep(REQUEST_SPACING_MS);
  }

  const status = "COMPLETED";
  const runtimeMs = Date.now() - startedMs;
  await finishRun(runId, JOB, YAHOO_HOLDINGS_SOURCE, startedMs, {
    status, attempted, completed: fetched, inserted: written, updated: 0, failed: errorCount,
    retryableFailures: rateLimited ? sorted.length - attempted : 0, checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), eligible_count: sorted.length, offshore_mapping_size: offshoreMapping.length,
      domestic_mapping_size: domesticMapping.length, offshore_attempted: offshoreAttempted, offshore_fetched: offshoreFetched,
      domestic_attempted: domesticAttempted, domestic_fetched: domesticFetched, fetched, written,
      writable_row_count: writableRowCount, error_count: errorCount, rate_limited: rateLimited, http_status: httpStatus,
      stopped_reason: stoppedReason, runtime_seconds: Math.round(runtimeMs / 1000), fresh_days: FRESH_DAYS,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(), eligibleCount: sorted.length,
    offshoreMappingSize: offshoreMapping.length, domesticMappingSize: domesticMapping.length,
    offshoreAttempted, offshoreFetched, domesticAttempted, domesticFetched,
    attempted, fetched, written, writableRowCount, errorCount, rateLimited, httpStatus, stoppedReason,
    runtimeSeconds: Math.round(runtimeMs / 1000),
  });
}
