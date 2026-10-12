// Task R3/Z follow-up: auto-updates NAV for the subset of the 962 tdcc-offshore funds whose Yahoo
// mapping (lib/offshore-nav-sync/mapping.ts, seeded once into the existing
// production_scheduler_checkpoints table -- no new table) was an EXACT name match with no currency or
// class inconsistency flagged. Anything flagged "有疑慮" during the original sweep is permanently
// excluded here, never guessed at.
//
// One Yahoo request per fund (FundServices.fundsPriceHistory), >=1.1s apart, inside a 240s wall-clock
// budget per invocation -- the daily 09:00-12:00 Taipei / 15-min schedule spreads the ~894 eligible
// funds across several ticks. Completion is DB-truth plus a same-day "already attempted" set (its own
// checkpoint key) so a fund is never re-hit twice in the same calendar day. ±20% jump guard
// (navSanity.ts). SHADOW MODE BY DEFAULT: unless OFFSHORE_NAV_SYNC_WRITE is exactly "on", this route
// fetches and classifies but writes nothing.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey } from "@/lib/cloud-ingestion/runContext";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import { loadDailyProgress, saveDailyProgress } from "@/lib/offshore-nav-sync/completion";
import { fetchOffshoreNav, RateLimitedError } from "@/lib/offshore-nav-sync/navFetch";
import { checkOffshoreNavSanity } from "@/lib/offshore-nav-sync/navSanity";
import { isWriteEnabled, currentRunMode } from "@/lib/offshore-nav-sync/writeGate";
import { writeBatchIfEnabled, type QueryFn } from "@/lib/offshore-nav-sync/navWriter";
import type { OffshoreNavCandidate } from "@/lib/offshore-nav-sync/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "OFFSHORE_NAV_SYNC";
const TIME_BUDGET_MS = 240_000;
const REQUEST_SPACING_MS = 1_100;
const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabledThisRun = isWriteEnabled();
  const today = new Date().toISOString().slice(0, 10);

  const runKey = hourBucketKey("offshore-nav-sync");
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_FUND_PRICE_HISTORY", runKey,
    universeCount: 0, batchSize: 200, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey, runMode: currentRunMode() });
  }

  const mapping = await loadMapping(query);
  if (mapping.length === 0) {
    await finishRun(runId, JOB, "YAHOO_FUND_PRICE_HISTORY", startedMs, {
      status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      error: null, checkpointAfter: null,
      details: { run_mode: currentRunMode(), reason: "MAPPING_EMPTY_NOT_YET_SEEDED" },
    });
    return Response.json({ ok: true, job: JOB, runId, status: "COMPLETED", mappingEmpty: true });
  }

  const attemptedToday = await loadDailyProgress(query, today);
  const pending = mapping.filter((m) => !attemptedToday.has(m.fundId));

  const fundIds = pending.map((m) => m.fundId);
  const navRows = fundIds.length
    ? await prisma.$queryRawUnsafe<Array<{ id: string; latest_nav: string | null }>>(
        `SELECT id, latest_nav::text FROM funds WHERE id = ANY($1::text[])`,
        fundIds,
      )
    : [];
  const latestNavByFundId = new Map<string, number | null>();
  for (const r of navRows) latestNavByFundId.set(r.id, r.latest_nav != null ? Number(r.latest_nav) : null);

  const candidates: OffshoreNavCandidate[] = [];
  let attempted = 0;
  let rateLimited = false;
  let httpStatus: number | null = null;
  let jumpReviewCount = 0;
  let noDataCount = 0;
  let errorCount = 0;
  const newlyAttempted = new Set<string>();

  for (const m of pending) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    attempted++;
    try {
      const result = await fetchOffshoreNav(m.yahooFundId);
      newlyAttempted.add(m.fundId);
      if (!result) { noDataCount++; await sleep(REQUEST_SPACING_MS); continue; }
      const lastKnown = latestNavByFundId.get(m.fundId) ?? null;
      const sanity = checkOffshoreNavSanity(result.nav, lastKnown);
      if (sanity === "JUMP_REVIEW") { jumpReviewCount++; await sleep(REQUEST_SPACING_MS); continue; }
      candidates.push({ fundId: m.fundId, navDate: result.navDate, nav: result.nav });
    } catch (e) {
      if (e instanceof RateLimitedError) {
        rateLimited = true;
        httpStatus = e.httpStatus;
        break; // stop immediately on 401/403/429, do not sleep further
      }
      errorCount++;
      newlyAttempted.add(m.fundId);
    }
    await sleep(REQUEST_SPACING_MS);
  }

  const writeResult = await writeBatchIfEnabled(query, candidates, new Date().toISOString(), writeEnabledThisRun);

  const mergedAttempted = new Set([...attemptedToday, ...newlyAttempted]);
  await saveDailyProgress(query, today, mergedAttempted);

  const status = "COMPLETED";
  await finishRun(runId, JOB, "YAHOO_FUND_PRICE_HISTORY", startedMs, {
    status, attempted, completed: writeResult.written, inserted: writeResult.written, updated: 0,
    failed: errorCount + writeResult.writeErrorCount, retryableFailures: rateLimited ? pending.length - attempted : 0,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), mapping_size: mapping.length, pending_before_run: pending.length,
      attempted, no_data_count: noDataCount, jump_review_count: jumpReviewCount, error_count: errorCount,
      rate_limited: rateLimited, http_status: httpStatus,
      write_candidate_count: candidates.length, written: writeResult.written, write_error_count: writeResult.writeErrorCount,
      attempted_today_total: mergedAttempted.size,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    mappingSize: mapping.length, pendingBeforeRun: pending.length, attempted,
    noDataCount, jumpReviewCount, errorCount, rateLimited, httpStatus,
    writeCandidateCount: candidates.length, written: writeResult.written, writeErrorCount: writeResult.writeErrorCount,
  });
}
