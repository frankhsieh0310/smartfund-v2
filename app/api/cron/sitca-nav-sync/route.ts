// Task Z: domestic (TWD) mutual-fund NAV sync from SITCA's own official daily CSV — a brand-new
// file/endpoint, does not touch app/api/cron/cloud-fund-nav/route.ts or lib/cloud-ingestion/
// fundNav.ts at all (separate fetch/parse in lib/sitca-nav-sync/sitcaFetch.ts).
//
// Matching (Part A2, user-approved): code-first (SITCA's own 基金統編 == funds.code — VERIFIED live
// at 95.4% of rows), normalized-name fallback for the rest (+0.3%, 95.7% total). A row matching
// neither is reported as unmatched and NEVER creates a new fund.
//
// Completion is naturally DB-truth here, with no separate "missing" pre-check needed the way
// market-close-sync/us-fund-nav-sync require one: the entire candidate set comes from ONE cheap CSV
// fetch (not N per-item API calls), so every matched row is simply re-attempted every run, and the
// writer's own "newer-or-same-date-different-value" WHERE clause (navWriter.ts) makes an
// already-up-to-date row a no-op update rather than something that needs to be skipped in advance.
//
// SHADOW MODE BY DEFAULT: unless SITCA_NAV_SYNC_WRITE is exactly "on" (lib/sitca-nav-sync/
// writeGate.ts), this route fetches, matches, and classifies but writes nothing.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey } from "@/lib/cloud-ingestion/runContext";
import { fetchSitcaRows } from "@/lib/sitca-nav-sync/sitcaFetch";
import { matchSitcaRows, type FundRow } from "@/lib/sitca-nav-sync/matching";
import { checkNavSanity } from "@/lib/sitca-nav-sync/navSanity";
import { isWriteEnabled, currentRunMode } from "@/lib/sitca-nav-sync/writeGate";
import { writeBatchIfEnabled, type QueryFn } from "@/lib/sitca-nav-sync/navWriter";
import type { SitcaMatchedCandidate } from "@/lib/sitca-nav-sync/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "SITCA_NAV_SYNC";
const writerQuery: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabledThisRun = isWriteEnabled();

  // Hour-bucketed run_key (same pattern as cloud-etf-price) — this route is cheap (one CSV fetch,
  // no per-item HTTP calls) so it's safe to re-run every invocation; the bucket just avoids two
  // overlapping invocations in the same clock hour double-fetching the CSV for no reason.
  const runKey = hourBucketKey("sitca-nav-sync");
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV", runKey,
    universeCount: 0, batchSize: 500, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey, runMode: currentRunMode() });
  }

  let rows: Awaited<ReturnType<typeof fetchSitcaRows>>;
  try {
    rows = await fetchSitcaRows();
  } catch (e: any) {
    if (e?.rateLimited) {
      await finishRun(runId, JOB, "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV", startedMs, {
        status: "PARTIAL", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
        error: String(e?.message ?? e), checkpointAfter: null,
        details: { run_mode: currentRunMode(), rate_limited: true, http_status: e?.httpStatus ?? null },
      });
      return Response.json({ ok: false, job: JOB, runId, status: "PARTIAL", rateLimited: true, httpStatus: e?.httpStatus ?? null });
    }
    await finishRun(runId, JOB, "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV", startedMs, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      error: String(e?.message ?? e), checkpointAfter: null,
      details: { run_mode: currentRunMode() },
    });
    return Response.json({ ok: false, job: JOB, runId, status: "FAILED", error: String(e?.message ?? e) }, { status: 502 });
  }

  const fundRows = await prisma.$queryRawUnsafe<FundRow[]>(`SELECT id, code, name, currency FROM funds WHERE currency = 'TWD'`);
  const { matched, unmatched } = matchSitcaRows(rows, fundRows);

  // Currency gate (user-approved Step 1, Task Z write-enable pre-check Part b): funds.currency is
  // fund-family-level, not per-share-class, so a SITCA row denominated in e.g. USD/JPY/CNY will
  // disagree with a TWD-tagged fund row even when the match itself (name/class) is correct. Per the
  // explicit rule, these are reported and skipped — never written — until the underlying funds.currency
  // data-quality gap (Part 2 investigation) is fixed.
  let currencyMismatchCount = 0;
  const currencyOk = matched.filter((m) => {
    if (m.sitcaCurrency === m.fundCurrency) return true;
    currencyMismatchCount++;
    return false;
  });

  // Sanity check against each fund's own current latest_nav before it's allowed into the write
  // batch — same two-failure-mode philosophy as market-close-sync's priceSanity.ts, with a stricter
  // 20% threshold appropriate for a fund NAV (lib/sitca-nav-sync/navSanity.ts).
  const latestNavByFundId = new Map<string, number | null>();
  if (currencyOk.length > 0) {
    const navRows = await prisma.$queryRawUnsafe<Array<{ id: string; latest_nav: string | null }>>(
      `SELECT id, latest_nav::text FROM funds WHERE id = ANY($1::text[])`,
      [...new Set(currencyOk.map((m) => m.fundId))],
    );
    for (const r of navRows) latestNavByFundId.set(r.id, r.latest_nav != null ? Number(r.latest_nav) : null);
  }

  const candidates: SitcaMatchedCandidate[] = [];
  let unitMismatchCount = 0;
  let jumpReviewCount = 0;
  for (const m of currencyOk) {
    const lastKnown = latestNavByFundId.get(m.fundId) ?? null;
    const sanity = checkNavSanity(m.nav, lastKnown);
    if (sanity === "UNIT_MISMATCH") { unitMismatchCount++; continue; }
    if (sanity === "JUMP_REVIEW") { jumpReviewCount++; continue; }
    candidates.push({ fundId: m.fundId, navDate: m.navDate, nav: m.nav, matchedBy: m.matchedBy });
  }

  const writeResult = await writeBatchIfEnabled(writerQuery, candidates, new Date().toISOString(), writeEnabledThisRun);

  const matchedByCode = matched.filter((m) => m.matchedBy === "CODE").length;
  const matchedByName = matched.filter((m) => m.matchedBy === "NAME").length;

  const status = "COMPLETED";
  await finishRun(runId, JOB, "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV", startedMs, {
    status, attempted: rows.length, completed: writeResult.written, inserted: writeResult.written, updated: 0,
    failed: unmatched.length + writeResult.writeErrorCount, retryableFailures: 0, checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), csv_row_count: rows.length, twd_fund_count: fundRows.length,
      matched_count: matched.length, matched_by_code: matchedByCode, matched_by_name: matchedByName,
      unmatched_count: unmatched.length, currency_mismatch_count: currencyMismatchCount,
      unit_mismatch_count: unitMismatchCount, jump_review_count: jumpReviewCount,
      write_candidate_count: candidates.length, written: writeResult.written, write_error_count: writeResult.writeErrorCount,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    csvRowCount: rows.length, twdFundCount: fundRows.length,
    matchedCount: matched.length, matchedByCode, matchedByName, unmatchedCount: unmatched.length,
    currencyMismatchCount, unitMismatchCount, jumpReviewCount, writeCandidateCount: candidates.length,
    written: writeResult.written, writeErrorCount: writeResult.writeErrorCount,
  });
}
