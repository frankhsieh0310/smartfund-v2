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
// Selection (2026-10-18, both modes unified -- see below): a rotation cursor
// (shadowCursor.ts, production_scheduler_checkpoints key "holdings-alt-source-sync:shadow-cursor")
// tracks which fundIds have been VISITED (checked against the source) in the current cycle,
// independent of whether a write happened. Wraps back to the start once every fund in the universe
// has been visited. This guarantees every fund gets checked against the source within one rotation,
// instead of the old WRITE-mode behavior (selection.ts's selectOldestFirst + FRESH_DAYS) which
// skipped any fund written within the last 25 days WITHOUT ever re-checking the source -- that
// violated the standing rule that "每天更新" means checking the source every day, not just
// re-using a local freshness window. selection.ts/selectOldestFirst still exists (and is unit
// tested) but is no longer called from this route; writing itself is unchanged -- writer.ts only
// creates a new filing_id when the source's own asOfDate actually moved forward, so re-checking an
// unchanged source is a harmless idempotent no-op.
// Scheduled hourly at :52 (vercel.json); 280s time budget per invocation.
//
// ETF constituent sources: no new work needed, lib/etf-holdings-engine/ already covers this via
// official per-issuer disclosure. SITCA top-10 domestic holdings: researched, not found/implemented
// this round -- see scratch/overnight-report-20261013.md Part 2.
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import { loadDomesticYahooMapping } from "@/lib/holdings-alt-source/domesticYahooMapping";
import { loadShadowCursor, saveShadowCursor, selectShadowBatch } from "@/lib/holdings-alt-source/shadowCursor";
import { fetchYahooOffshoreHoldings, YahooRateLimitedError, YAHOO_HOLDINGS_SOURCE } from "@/lib/holdings-alt-source/yahooOffshoreHoldings";
import { writeYahooOffshoreHoldings, type QueryFn } from "@/lib/holdings-alt-source/writer";
import { isWriteEnabled, currentRunMode } from "@/lib/holdings-alt-source/writeGate";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "HOLDINGS_ALT_SOURCE_SYNC";
// Raised from 150s to 280s this round (audit found ~39/run empirically against a 2,168-mapping
// universe -> ~2.3 days/pass at hourly cadence): maxDuration=300s gives 20s margin.
// REQUEST_SPACING_MS is untouched (anti-scraping pace, not the lever to pull).
const TIME_BUDGET_MS = 280_000;
const REQUEST_SPACING_MS = 3_000;
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

  // 2026-10-18 (使用者規則定案): 「所有資料每天更新」規則禁止用「N 天內不重抓」跳過檢查
  // ——selectOldestFirst()/FRESH_DAYS 會讓最近 25 天內寫過的基金完全不進入候選清單，等於
  // 從來沒有去源頭確認「今天有沒有新揭露」。改成跟 SHADOW 模式同一套輪轉游標（每天都檢查
  // 下一批，不管上次寫入是多久以前），WRITE／SHADOW 兩種模式共用同一個 cursor 機制，確保
  // 每檔基金最終都會被檢查過一輪，不會因為「最近才寫過」就被永久跳過。寫入本身仍然是
  // writer.ts 既有的「asOfDate 變了才會產生新 filing_id」邏輯，來源真的有新揭露當天就會寫入；
  // 沒有新揭露時重複檢查只是一次 idempotent 的 no-op，不會動到既有資料。
  const cursorBefore = await loadShadowCursor(query);
  const picked = selectShadowBatch(combined, cursorBefore);
  const sorted = picked.batch;
  const shadowCycleWillReset = picked.cycleWillReset;
  const shadowCursorBefore = picked.startingState; // already reset to empty here if the cycle wrapped

  let attempted = 0, fetched = 0, written = 0, writableRowCount = 0, errorCount = 0, rateLimited = false;
  let httpStatus: number | null = null;
  let consecutiveFailures = 0;
  let stoppedReason: string | null = null;
  let offshoreAttempted = 0, offshoreFetched = 0, domesticAttempted = 0, domesticFetched = 0;
  const offshoreFundIds = new Set(offshoreMapping.map((m) => m.fundId));
  const visitedThisRun: string[] = [];

  for (const entry of sorted) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { stoppedReason = "TIME_BUDGET_EXCEEDED"; break; }
    attempted++;
    visitedThisRun.push(entry.fundId);
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

  // Cursor is now saved every run regardless of mode -- WRITE mode must also advance the rotation
  // so a fund gets checked against the source even when its last write is recent.
  const updatedProcessed = [...new Set([...shadowCursorBefore.processedFundIds, ...visitedThisRun])];
  await saveShadowCursor(query, runId, { processedFundIds: updatedProcessed, cycleStartedAt: shadowCursorBefore.cycleStartedAt });

  // 2026-10-18 fix: previously hardcoded to "COMPLETED" regardless of outcome -- a run that got
  // rate-limited, hit consecutive failures, or ran out of time budget before finishing its batch
  // still reported COMPLETED, so the health report (and any human) had no way to see trouble here.
  const status = rateLimited || stoppedReason === `CONSECUTIVE_FAILURES_${MAX_CONSECUTIVE_FAILURES}`
    ? "FAILED"
    : stoppedReason === "TIME_BUDGET_EXCEEDED" || errorCount > 0
      ? "PARTIAL"
      : "COMPLETED";
  const runtimeMs = Date.now() - startedMs;
  await finishRun(runId, JOB, YAHOO_HOLDINGS_SOURCE, startedMs, {
    status, attempted, completed: fetched, inserted: written, updated: 0, failed: errorCount,
    retryableFailures: rateLimited ? sorted.length - attempted : 0, checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), eligible_count: sorted.length, offshore_mapping_size: offshoreMapping.length,
      domestic_mapping_size: domesticMapping.length, offshore_attempted: offshoreAttempted, offshore_fetched: offshoreFetched,
      domestic_attempted: domesticAttempted, domestic_fetched: domesticFetched, fetched, written,
      writable_row_count: writableRowCount, error_count: errorCount, rate_limited: rateLimited, http_status: httpStatus,
      stopped_reason: stoppedReason, runtime_seconds: Math.round(runtimeMs / 1000),
      shadow_cycle_reset: shadowCycleWillReset,
      shadow_cycle_processed_before_this_run: shadowCursorBefore.processedFundIds.length,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(), eligibleCount: sorted.length,
    offshoreMappingSize: offshoreMapping.length, domesticMappingSize: domesticMapping.length,
    offshoreAttempted, offshoreFetched, domesticAttempted, domesticFetched,
    attempted, fetched, written, writableRowCount, errorCount, rateLimited, httpStatus, stoppedReason,
    runtimeSeconds: Math.round(runtimeMs / 1000),
    shadowCycleReset: shadowCycleWillReset,
  });
}
