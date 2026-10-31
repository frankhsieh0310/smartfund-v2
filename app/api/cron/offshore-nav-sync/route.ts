// Task R3/Z follow-up: auto-updates NAV for the subset of tdcc-offshore funds whose Yahoo mapping
// (lib/offshore-nav-sync/mapping.ts, stored in the existing production_scheduler_checkpoints table
// -- no new table) was an EXACT name match with no currency or class inconsistency flagged. Anything
// flagged "有疑慮" during the original one-time sweep (2026-10-12) is permanently excluded here,
// never guessed at.
//
// 2026-10-21: that sweep was one-time and the mapping never grew -- any fund approved afterward had
// no chance to be in it at all (453 of the 532-fund core_universe_fund gap, verified). Each run now
// spends a small bounded slice (discoverMapping.ts, DISCOVERY_TIME_BUDGET_MS below) trying to
// resolve newly-approved funds the same way the original sweep did (EXACT name match only), and
// persists anything it finds back into the same checkpoint row -- so the mapping keeps growing on
// its own instead of needing another one-time sweep. Anything it can't resolve exactly is logged
// with evidence (details.mapping_unresolved_sample) and stays excluded, same as the original rule.
//
// One Yahoo request per fund (FundServices.fundsPriceHistory), >=1.1s apart, inside a 240s wall-clock
// budget per invocation -- the daily 09:00-12:00 Taipei / 15-min schedule spreads the ~894 eligible
// funds across several ticks. Completion is DB-truth plus a same-day "already attempted" set (its own
// checkpoint key) so a fund is never re-hit twice in the same calendar day. ±20% jump guard
// (navSanity.ts). SHADOW MODE BY DEFAULT: unless OFFSHORE_NAV_SYNC_WRITE is exactly "on", this route
// fetches and classifies but writes nothing.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadMapping, MAPPING_CHECKPOINT_KEY } from "@/lib/offshore-nav-sync/mapping";
import { discoverNewMappings } from "@/lib/offshore-nav-sync/discoverMapping";
import { loadDailyProgress, saveDailyProgress, loadDiscoveryProgress, saveDiscoveryProgress } from "@/lib/offshore-nav-sync/completion";
import { loadKnownNoData, saveKnownNoData, isOnCooldown } from "@/lib/offshore-nav-sync/knownNoData";
import { fetchOffshoreNav, RateLimitedError } from "@/lib/offshore-nav-sync/navFetch";
import { checkOffshoreNavSanity } from "@/lib/offshore-nav-sync/navSanity";
import { isWriteEnabled, currentRunMode } from "@/lib/offshore-nav-sync/writeGate";
import { writeBatchIfEnabled, type QueryFn } from "@/lib/offshore-nav-sync/navWriter";
import type { OffshoreNavCandidate } from "@/lib/offshore-nav-sync/types";
import { loadDomesticYahooMapping } from "@/lib/holdings-alt-source/domesticYahooMapping";
import { isBackfillWriteEnabled } from "@/lib/offshore-nav-sync/backfillWriteGate";
import {
  loadBackfillDone, saveBackfillDone, fetchOffshoreNavHistoryRange, writeBackfillHistory,
  RateLimitedError as BackfillRateLimitedError,
} from "@/lib/offshore-nav-sync/historyBackfill";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "OFFSHORE_NAV_SYNC";
const TIME_BUDGET_MS = 240_000;
const REQUEST_SPACING_MS = 1_100;
const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

// Historical NAV catch-up (one-time per fund, see historyBackfill.ts) rides this same invocation
// instead of its own cron entry -- it only spends whatever wall-clock the daily top-up above didn't
// need, capped well under maxDuration. 不准在台北01:00-05:30執行(使用者規則) -- this cron's own
// schedule (vercel.json: UTC 1-3 + UTC4 = Taipei 09:00-12:00) never overlaps that window, this is a
// defensive guard in case the schedule ever changes or the route is triggered manually.
const BACKFILL_JOB = "FUND_HISTORY_BACKFILL";
const BACKFILL_DEADLINE_MS = 280_000; // 20s safety margin before maxDuration=300s
const BACKFILL_REQUEST_SPACING_MS = 2_000; // heavier payload (years of history) than the daily 1-point fetch
const BACKFILL_YEARS = 5;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= 60 && taipeiMinutes < 330; // 01:00-05:30
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabledThisRun = isWriteEnabled();
  const today = new Date().toISOString().slice(0, 10);

  // Unique per invocation (not hour-bucketed) -- an hour bucket meant sequential same-hour triggers
  // overwrote each other's audit row via the ON CONFLICT(run_key) upsert, silently discarding the
  // per-run details of every run but the last one within that hour even though their real NAV writes
  // all genuinely happened. beginRun's own RUNNING+fresh guard still prevents true concurrent overlap.
  const runKey = `offshore-nav-sync:${new Date(startedMs).toISOString()}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_FUND_PRICE_HISTORY", runKey,
    universeCount: 0, batchSize: 200, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present and running", runKey, runMode: currentRunMode() });
  }

  const mapping = await loadMapping(query);
  if (mapping.length === 0) {
    // 2026-10-22（使用者核准，三.三稽核發現）: 這個分支之前回報COMPLETED——如果mapping一直是空的
    // （不是「這次剛好跑完seed」而是「seed從來沒做過/被清空」），每次都COMPLETED會完全看不出
    // 這支job其實什麼都沒做。改回報SKIPPED，讓checkPipelineRunLog的連續SKIPPED偵測能抓到。
    await finishRun(runId, JOB, "YAHOO_FUND_PRICE_HISTORY", startedMs, {
      status: "SKIPPED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      error: null, checkpointAfter: null,
      details: { run_mode: currentRunMode(), reason: "MAPPING_EMPTY_NOT_YET_SEEDED" },
    });
    return Response.json({ ok: true, job: JOB, runId, status: "SKIPPED", mappingEmpty: true });
  }

  // 2026-10-21（使用者核准）: the mapping was a one-time sweep (see mapping.ts's own doc comment) and
  // never grew as new tdcc-offshore funds got approved -- 453 of the 532-fund core_universe_fund gap
  // were created after that sweep and never had a chance to be in it at all. Self-extend it here:
  // bounded, rate-limited, EXACT-name-match only (same rule the original sweep used), appended to
  // (never replacing) the existing 876 entries. This slice shares the route's overall wall clock but
  // is capped well under it, so it can never starve the NAV-fetch budget below a useful minimum.
  const DISCOVERY_TIME_BUDGET_MS = 45_000;
  const DISCOVERY_REQUEST_SPACING_MS = 1_100;
  // 2026-10-28（使用者核准修正，「39檔境外淨值落後」VERIFIED根因，見completion.ts的
  // DISCOVERY_PROGRESS_CHECKPOINT_KEY說明）: 候選清單固定newest-first，45秒預算每輪都只碰得到
  // 最前面那一截，後面的候選永遠排不到——改用跟NAV-fetch階段同樣的「今天已經試過」機制，讓
  // 每輪往候選清單後面推進。
  const discoveryAttemptedToday = await loadDiscoveryProgress(query, today);
  const { discovered, unresolved, attemptedThisRun: discoveryAttemptedThisRun } = await discoverNewMappings(query, mapping, DISCOVERY_TIME_BUDGET_MS, DISCOVERY_REQUEST_SPACING_MS, discoveryAttemptedToday);
  if (discovered.length > 0) {
    mapping.push(...discovered);
    // Same SHADOW MODE gate as everything else below -- discovery still runs and classifies (so a
    // shadow-mode Preview run's own report is accurate), but only a write-enabled run persists the
    // extended mapping, consistent with "writes nothing" unless OFFSHORE_NAV_SYNC_WRITE is "on".
    if (writeEnabledThisRun) {
      await writeCheckpoint(JOB, MAPPING_CHECKPOINT_KEY, runId, { lastSymbol: JSON.stringify(mapping), processed: mapping.length, succeeded: discovered.length, failed: unresolved.length });
    }
  }
  if (writeEnabledThisRun && discoveryAttemptedThisRun.length > 0) {
    const mergedDiscoveryAttempted = new Set([...discoveryAttemptedToday, ...discoveryAttemptedThisRun]);
    await saveDiscoveryProgress(query, today, mergedDiscoveryAttempted);
  }

  const attemptedToday = await loadDailyProgress(query, today);
  const knownNoData = await loadKnownNoData(query);
  const nowDate = new Date(startedMs);
  const onCooldown = (fundId: string) => isOnCooldown(fundId, knownNoData, nowDate);
  const pending = mapping.filter((m) => !attemptedToday.has(m.fundId) && !onCooldown(m.fundId));
  const cooldownSkippedCount = mapping.filter((m) => !attemptedToday.has(m.fundId) && onCooldown(m.fundId)).length;

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
      // Only a real (write-enabled) attempt consumes today's slot -- a shadow-mode run still fetches
      // (to classify/report) but must not block a later write-mode run from re-attempting this fund.
      if (writeEnabledThisRun) newlyAttempted.add(m.fundId);
      if (!result) {
        noDataCount++;
        if (writeEnabledThisRun) knownNoData.set(m.fundId, nowDate.toISOString());
        await sleep(REQUEST_SPACING_MS);
        continue;
      }
      if (writeEnabledThisRun) knownNoData.delete(m.fundId); // started returning data again
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
      if (writeEnabledThisRun) newlyAttempted.add(m.fundId);
    }
    await sleep(REQUEST_SPACING_MS);
  }

  const writeResult = await writeBatchIfEnabled(query, candidates, new Date().toISOString(), writeEnabledThisRun);

  const mergedAttempted = new Set([...attemptedToday, ...newlyAttempted]);
  if (writeEnabledThisRun) {
    await saveDailyProgress(query, today, mergedAttempted);
    await saveKnownNoData(query, knownNoData);
  }

  // 2026-10-22（使用者核准，三.三稽核發現）: 之前不論errorCount/有沒有真的寫入都無條件回報
  // COMPLETED。
  const status = errorCount > 0 && writeResult.written === 0 ? "FAILED"
    : errorCount > 0 || writeResult.writeErrorCount > 0 ? "PARTIAL"
    : writeEnabledThisRun && attempted > 0 && writeResult.written === 0 ? "PARTIAL"
    : "COMPLETED";
  await finishRun(runId, JOB, "YAHOO_FUND_PRICE_HISTORY", startedMs, {
    status, attempted, completed: writeResult.written, inserted: writeResult.written, updated: 0,
    failed: errorCount + writeResult.writeErrorCount, retryableFailures: rateLimited ? pending.length - attempted : 0,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), mapping_size: mapping.length, pending_before_run: pending.length,
      attempted, no_data_count: noDataCount, jump_review_count: jumpReviewCount, error_count: errorCount,
      rate_limited: rateLimited, http_status: httpStatus,
      write_candidate_count: candidates.length, written: writeResult.written, write_error_count: writeResult.writeErrorCount,
      attempted_today_total: mergedAttempted.size, cooldown_skipped_count: cooldownSkippedCount,
      mapping_discovered_count: discovered.length, mapping_unresolved_count: unresolved.length,
      mapping_unresolved_sample: unresolved.slice(0, 10),
      discovery_attempted_this_run: discoveryAttemptedThisRun.length, discovery_attempted_today_total: discoveryAttemptedToday.size + discoveryAttemptedThisRun.length,
    },
  });

  // --- Historical NAV catch-up (one-time per fund) -- see historyBackfill.ts header comment.
  // Isolated: any failure here must never affect the daily top-up result already computed above.
  let backfillSummary: Record<string, unknown> | null = null;
  try {
    backfillSummary = await runHistoryBackfillSlice(startedMs, mapping);
  } catch (e) {
    backfillSummary = { error: String((e as Error).message ?? e) };
  }

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    mappingSize: mapping.length, pendingBeforeRun: pending.length, attempted,
    noDataCount, jumpReviewCount, errorCount, rateLimited, httpStatus,
    writeCandidateCount: candidates.length, written: writeResult.written, writeErrorCount: writeResult.writeErrorCount,
    mappingDiscoveredCount: discovered.length, mappingUnresolvedCount: unresolved.length,
    backfill: backfillSummary,
  });
}

/** Spends whatever wall-clock remains (up to BACKFILL_DEADLINE_MS total for this invocation) walking
 * the combined offshore+domestic Yahoo mapping, backfilling each not-yet-done fund's history once.
 * Own run log (FUND_HISTORY_BACKFILL) so the health report and this job's progress are tracked
 * independently of the daily top-up above. */
async function runHistoryBackfillSlice(outerStartedMs: number, offshoreMapping: Array<{ fundId: string; yahooFundId: string }>) {
  if (isWithinForbiddenTaipeiWindow(new Date())) {
    return { skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" };
  }
  if (Date.now() - outerStartedMs > BACKFILL_DEADLINE_MS) {
    return { skipped: true, reason: "NO_TIME_LEFT_AFTER_DAILY_SYNC" };
  }

  const backfillStartedMs = Date.now();
  const writeEnabled = isBackfillWriteEnabled();
  const runKey = `fund-history-backfill:${new Date(backfillStartedMs).toISOString()}`;
  const { runId, skipped } = await beginRun({
    jobName: BACKFILL_JOB, provider: "YAHOO_FUND_PRICE_HISTORY", runKey, universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) return { skipped: true, reason: "run_key already present and running" };

  const domesticMapping = await loadDomesticYahooMapping(query);
  const combined = [...offshoreMapping, ...domesticMapping];
  const done = await loadBackfillDone(query);
  const pending = combined.filter((m) => !done.has(m.fundId));

  const fundIds = pending.map((m) => m.fundId);
  const inceptionRows = fundIds.length
    ? await query(`SELECT id, inception_date::text AS "inceptionDate" FROM funds WHERE id = ANY($1::text[])`, [fundIds])
    : [];
  const inceptionByFundId = new Map<string, string | null>(inceptionRows.map((r: any) => [r.id, r.inceptionDate]));

  let attempted = 0, noDataCount = 0, errorCount = 0, totalWritten = 0, rateLimited = false;
  let httpStatus: number | null = null;
  const newlyDone = new Set<string>();
  const toDate = new Date(backfillStartedMs);

  for (const m of pending) {
    if (Date.now() - outerStartedMs > BACKFILL_DEADLINE_MS) break;
    attempted++;
    const inceptionIso = inceptionByFundId.get(m.fundId) ?? null;
    const fiveYearsAgo = new Date(toDate.getTime() - BACKFILL_YEARS * 365 * 86_400_000);
    const fromDate = inceptionIso && new Date(inceptionIso).getTime() > fiveYearsAgo.getTime() ? new Date(inceptionIso) : fiveYearsAgo;
    try {
      const points = await fetchOffshoreNavHistoryRange(m.yahooFundId, fromDate, toDate);
      if (!points) {
        noDataCount++;
        if (writeEnabled) newlyDone.add(m.fundId); // genuinely no history -- never retried
        await sleep(BACKFILL_REQUEST_SPACING_MS);
        continue;
      }
      if (writeEnabled) {
        totalWritten += await writeBackfillHistory(query, m.fundId, points, new Date().toISOString());
        newlyDone.add(m.fundId);
      }
    } catch (e) {
      if (e instanceof BackfillRateLimitedError) {
        rateLimited = true;
        httpStatus = e.httpStatus;
        break; // stop the whole backfill pass immediately on 401/403/429, no retry this run
      }
      errorCount++;
    }
    await sleep(BACKFILL_REQUEST_SPACING_MS);
  }

  if (writeEnabled && newlyDone.size > 0) {
    await saveBackfillDone(query, new Set([...done, ...newlyDone]));
  }

  const status = rateLimited ? "PARTIAL" : errorCount > 0 && totalWritten === 0 ? "FAILED" : errorCount > 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, BACKFILL_JOB, "YAHOO_FUND_PRICE_HISTORY", backfillStartedMs, {
    status, attempted, completed: totalWritten, inserted: totalWritten, updated: 0, failed: errorCount,
    retryableFailures: rateLimited ? pending.length - attempted : 0, checkpointAfter: null,
    details: {
      write_enabled: writeEnabled, combined_mapping_size: combined.length, pending_before_run: pending.length,
      attempted, no_data_count: noDataCount, error_count: errorCount, rate_limited: rateLimited, http_status: httpStatus,
      rows_written: totalWritten, done_total: done.size + newlyDone.size,
    },
  });

  return { status, attempted, noDataCount, errorCount, rateLimited, httpStatus, rowsWritten: totalWritten, doneTotal: done.size + newlyDone.size, pendingBeforeRun: pending.length };
}
