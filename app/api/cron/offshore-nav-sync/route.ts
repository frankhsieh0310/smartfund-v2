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
import { loadDailyProgress, saveDailyProgress } from "@/lib/offshore-nav-sync/completion";
import { loadKnownNoData, saveKnownNoData, isOnCooldown } from "@/lib/offshore-nav-sync/knownNoData";
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
    await finishRun(runId, JOB, "YAHOO_FUND_PRICE_HISTORY", startedMs, {
      status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      error: null, checkpointAfter: null,
      details: { run_mode: currentRunMode(), reason: "MAPPING_EMPTY_NOT_YET_SEEDED" },
    });
    return Response.json({ ok: true, job: JOB, runId, status: "COMPLETED", mappingEmpty: true });
  }

  // 2026-10-21（使用者核准）: the mapping was a one-time sweep (see mapping.ts's own doc comment) and
  // never grew as new tdcc-offshore funds got approved -- 453 of the 532-fund core_universe_fund gap
  // were created after that sweep and never had a chance to be in it at all. Self-extend it here:
  // bounded, rate-limited, EXACT-name-match only (same rule the original sweep used), appended to
  // (never replacing) the existing 876 entries. This slice shares the route's overall wall clock but
  // is capped well under it, so it can never starve the NAV-fetch budget below a useful minimum.
  const DISCOVERY_TIME_BUDGET_MS = 45_000;
  const DISCOVERY_REQUEST_SPACING_MS = 1_100;
  const { discovered, unresolved } = await discoverNewMappings(query, mapping, DISCOVERY_TIME_BUDGET_MS, DISCOVERY_REQUEST_SPACING_MS);
  if (discovered.length > 0) {
    mapping.push(...discovered);
    // Same SHADOW MODE gate as everything else below -- discovery still runs and classifies (so a
    // shadow-mode Preview run's own report is accurate), but only a write-enabled run persists the
    // extended mapping, consistent with "writes nothing" unless OFFSHORE_NAV_SYNC_WRITE is "on".
    if (writeEnabledThisRun) {
      await writeCheckpoint(JOB, MAPPING_CHECKPOINT_KEY, runId, { lastSymbol: JSON.stringify(mapping), processed: mapping.length, succeeded: discovered.length, failed: unresolved.length });
    }
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
      attempted_today_total: mergedAttempted.size, cooldown_skipped_count: cooldownSkippedCount,
      mapping_discovered_count: discovered.length, mapping_unresolved_count: unresolved.length,
      mapping_unresolved_sample: unresolved.slice(0, 10),
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    mappingSize: mapping.length, pendingBeforeRun: pending.length, attempted,
    noDataCount, jumpReviewCount, errorCount, rateLimited, httpStatus,
    writeCandidateCount: candidates.length, written: writeResult.written, writeErrorCount: writeResult.writeErrorCount,
    mappingDiscoveredCount: discovered.length, mappingUnresolvedCount: unresolved.length,
  });
}
