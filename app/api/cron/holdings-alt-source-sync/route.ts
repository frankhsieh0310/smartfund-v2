// Alternative-source fund holdings sync (offshore funds only, this round). Replaces nothing yet --
// writes to the SAME `holdings` table as the existing MoneyDJ pipeline (lib/cloud-ingestion/
// fundHoldings.ts) but under its own `source` value, so both coexist and can be compared before any
// cutover decision. SHADOW MODE BY DEFAULT: unless HOLDINGS_ALT_SOURCE_WRITE is exactly "on", this
// route fetches/matches but writes nothing (see lib/holdings-alt-source/writeGate.ts).
//
// This is NOT wired into vercel.json's crons -- adding it there would be an existing-schedule change,
// out of scope for this branch. It exists as a callable route for manual/future triggering only.
//
// Domestic (SITCA top-10) and ETF constituent sources were researched but not implemented this round
// -- see scratch/overnight-report-20261013.md Part 2 for what was found and why.
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import { fetchYahooOffshoreHoldings, YahooRateLimitedError, YAHOO_HOLDINGS_SOURCE } from "@/lib/holdings-alt-source/yahooOffshoreHoldings";
import { writeYahooOffshoreHoldings, type QueryFn } from "@/lib/holdings-alt-source/writer";
import { isWriteEnabled, currentRunMode } from "@/lib/holdings-alt-source/writeGate";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "HOLDINGS_ALT_SOURCE_SYNC";
const TIME_BUDGET_MS = 150_000;
const REQUEST_SPACING_MS = 1_100;
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

  const mapping = await loadMapping(query);

  let attempted = 0, fetched = 0, written = 0, errorCount = 0, rateLimited = false;
  let httpStatus: number | null = null;

  for (const entry of mapping) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    attempted++;
    try {
      const holdings = await fetchYahooOffshoreHoldings(entry.yahooFundId);
      if (holdings) {
        fetched++;
        const result = await writeYahooOffshoreHoldings(query, YAHOO_HOLDINGS_SOURCE, { fundId: entry.fundId, yahooFundId: entry.yahooFundId, holdings }, writeEnabledThisRun);
        written += result.written;
      }
    } catch (e) {
      if (e instanceof YahooRateLimitedError) {
        rateLimited = true;
        httpStatus = e.httpStatus;
        break;
      }
      errorCount++;
    }
    await sleep(REQUEST_SPACING_MS);
  }

  const status = "COMPLETED";
  await finishRun(runId, JOB, YAHOO_HOLDINGS_SOURCE, startedMs, {
    status, attempted, completed: fetched, inserted: written, updated: 0, failed: errorCount,
    retryableFailures: rateLimited ? mapping.length - attempted : 0, checkpointAfter: null,
    details: { run_mode: currentRunMode(), mapping_size: mapping.length, fetched, written, error_count: errorCount, rate_limited: rateLimited, http_status: httpStatus },
  });

  return Response.json({ ok: true, job: JOB, runId, status, runMode: currentRunMode(), mappingSize: mapping.length, attempted, fetched, written, errorCount, rateLimited, httpStatus });
}
