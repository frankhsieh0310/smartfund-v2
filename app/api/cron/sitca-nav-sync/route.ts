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

  // Candidate pool is NOT restricted by currency (fixed: used to be `WHERE currency = 'TWD'`, which
  // meant a fund whose currency had been corrected away from 'TWD' would silently fall out of this
  // query forever, even though it's still a legitimate SITCA-matched domestic/TDCC-listed fund).
  // Same non-currency condition as the mobile API's fund-list filter (data_provider exclusion) — the
  // in-memory currency gate below is what actually decides write eligibility per row.
  const fundRows = await prisma.$queryRawUnsafe<FundRow[]>(
    `SELECT id, code, name, currency FROM funds WHERE COALESCE(data_provider, '') NOT IN ('yahoo', 'SEC')`,
  );
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

  // 2026-10-21 夜間（使用者核准）: JUMP_REVIEW的既有邏輯每次都拿candidate跟funds.latest_nav比
  // ——但latest_nav本身因為一直被擋永遠沒更新，等於永遠拿「同一個過時的基準值」比對，只要基金
  // 真的發生一次性大幅變動（例如配息平準金調整、淨值重編），就會卡死：第一天合理擋下來review，
  // 但第二天、第三天…CSV的新值其實已經跟第一天的候選值很接近（代表不是單日雜訊，是真的新淨
  // 值），卻因為比較基準還是同一個舊值，天天被擋，資料永遠凍結（VERIFIED：永豐中國科技50大等
  // 4檔已經卡住3.5個月）。
  // 修正：查最近2天這個job的production_scheduler_runs details，看這檔基金是否也在那兩天的
  // jump_review_detail清單裡、而且候選值跟今天的候選值很接近（2%以內）——連續3天（含今天）都
  // 出現同一個新值，才判定是真實的淨值變動，不是單日雜訊，允許通過並寫入，在log跟details裡
  // 清楚標記是「override」，不是靜默放行。沒有連續3天證據的，維持原本行為（擋下、算
  // jumpReviewCount），不改變既有保守預設。
  const recentJumpReviewRows = await prisma.$queryRawUnsafe<Array<{ started_at: string; details: any }>>(
    `SELECT started_at::text, details FROM production_scheduler_runs
     WHERE job_id = $1 AND started_at >= now() - interval '3 days' AND status IN ('COMPLETED','PARTIAL')
     ORDER BY started_at DESC LIMIT 5`,
    [JOB],
  );
  const priorJumpReviewsByFund = new Map<string, number[]>(); // fundId -> [nav, nav, ...] from prior runs
  for (const row of recentJumpReviewRows) {
    for (const d of row.details?.jump_review_detail ?? []) {
      if (!priorJumpReviewsByFund.has(d.fundId)) priorJumpReviewsByFund.set(d.fundId, []);
      priorJumpReviewsByFund.get(d.fundId)!.push(d.candidateNav);
    }
  }

  const candidates: SitcaMatchedCandidate[] = [];
  let unitMismatchCount = 0;
  let jumpReviewCount = 0;
  const jumpReviewDetail: Array<{ fundId: string; candidateNav: number; lastKnownNav: number | null }> = [];
  const jumpReviewOverrides: Array<{ fundId: string; candidateNav: number; lastKnownNav: number | null; priorValues: number[] }> = [];
  for (const m of currencyOk) {
    const lastKnown = latestNavByFundId.get(m.fundId) ?? null;
    const sanity = checkNavSanity(m.nav, lastKnown);
    if (sanity === "UNIT_MISMATCH") { unitMismatchCount++; continue; }
    if (sanity === "JUMP_REVIEW") {
      const priorValues = priorJumpReviewsByFund.get(m.fundId) ?? [];
      const consistentWithPrior = priorValues.length >= 2 && priorValues.every((v) => Math.abs(v - m.nav) / m.nav <= 0.02);
      if (consistentWithPrior) {
        jumpReviewOverrides.push({ fundId: m.fundId, candidateNav: m.nav, lastKnownNav: lastKnown, priorValues });
        candidates.push({ fundId: m.fundId, navDate: m.navDate, nav: m.nav, matchedBy: m.matchedBy });
        continue;
      }
      jumpReviewCount++;
      jumpReviewDetail.push({ fundId: m.fundId, candidateNav: m.nav, lastKnownNav: lastKnown });
      continue;
    }
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
      jump_review_detail: jumpReviewDetail, jump_review_overrides: jumpReviewOverrides,
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
