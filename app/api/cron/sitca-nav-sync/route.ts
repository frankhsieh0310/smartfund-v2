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
import { runMonthlyFeeDisclosure, runMonthlyAumDisclosure } from "@/lib/sitca-nav-sync/monthlyDisclosureWriter";
import { runFundclearAnnualSync } from "@/lib/fundclear-annual-sync/writer";
import { runFundclearAumGapFill } from "@/lib/sitca-nav-sync/fundclearAumGapFill";
import { runFundCompanyBackfill } from "@/lib/sitca-nav-sync/companyBackfillWriter";
import { runNomuraProspectusFeeSync } from "@/lib/cloud-ingestion/fundProspectusFeeWriter";
import { runFundclearManagerSync } from "@/lib/fundclear-onshore/managerSync";

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

  // 2026-10-23（使用者核准，根因修正）: 從這裡到結尾，只要任何一步丟出例外（不只是上面
  // fetchSitcaRows那段），一律要走finishRun寫FAILED+真實錯誤訊息，不能讓例外直接往外傳、留下
  // 一筆永遠卡在IN_PROGRESS、沒有任何錯誤紀錄的production_scheduler_runs紀錄——這正是
  // 2026-10-22 03:33 UTC起連續21次卡住的根因（見下方try區塊內的實際bug）。
  try {
    // Candidate pool is NOT restricted by currency (fixed: used to be `WHERE currency = 'TWD'`, which
    // meant a fund whose currency had been corrected away from 'TWD' would silently fall out of this
    // query forever, even though it's still a legitimate SITCA-matched domestic/TDCC-listed fund).
    // Same non-currency condition as the mobile API's fund-list filter (data_provider exclusion) — the
    // in-memory currency gate below is what actually decides write eligibility per row.
    // 2026-10-31（使用者核准，商品範圍最高原則）: VERIFIED 6.7%(423/6319)的候選本來就不是
    // APPROVED——classify.ts的分類判斷本身不依賴NAV是否同步，兩者解耦，過濾掉不會影響新基金
    // 隔天被核准，只是不再浪費在使用者永遠看不到的商品上。
    const fundRows = await prisma.$queryRawUnsafe<FundRow[]>(
      `SELECT id, code, name, currency FROM funds WHERE COALESCE(data_provider, '') NOT IN ('yahoo', 'SEC')
         AND id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`,
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
    //
    // 2026-10-23根因修正: prisma.$queryRawUnsafe的參數是variadic（...values），不是接受一個陣列
    // 當作「params清單」——下面原本寫的`[JOB]`會把整個陣列`['SITCA_NAV_SYNC']`當成$1單一個值綁
    // 進去，變成拿text（job_id欄位）去跟text[]比，Postgres直接丟42883語法錯誤（operator does
    // not exist: text = text[]）。這個例外沒有被外層任何try/catch接住，從2026-10-22 03:33 UTC
    // 起每小時排程都在這裡炸掉、finishRun從未被呼叫，production_scheduler_runs那筆紀錄永遠卡
    // 在IN_PROGRESS——這才是21筆卡住紀錄的真正根因，跟fund_history表大小、鎖等待都無關（已用
    // EXPLAIN ANALYZE跟實際20筆fund_id寫入測試證明那些路徑本身都是正常速度）。正確寫法是直接
    // 傳`JOB`這個字串本身（讓它被spread成一個值），不要包一層陣列。
    const recentJumpReviewRows = await prisma.$queryRawUnsafe<Array<{ started_at: string; details: any }>>(
      `SELECT started_at::text, details FROM production_scheduler_runs
       WHERE job_id = $1 AND started_at >= now() - interval '3 days' AND status IN ('COMPLETED','PARTIAL')
       ORDER BY started_at DESC LIMIT 5`,
      JOB,
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

    // 2026-10-31（使用者核准）: 境內基金費用揭露(IN2211)與規模揭露(IN2201)併進這支既有的
    // sitca-nav-sync cron，不另外新增cron entry。各自有自己的run_key（每月一次）、自己的寫入開關
    // （SITCA_FEE_DISCLOSURE_WRITE / SITCA_AUM_DISCLOSURE_WRITE），shadow模式預設不寫入。失敗不影響
    // 上面每日NAV同步的結果判定。
    let feeDisclosureResult: Awaited<ReturnType<typeof runMonthlyFeeDisclosure>> | null = null;
    let aumDisclosureResult: Awaited<ReturnType<typeof runMonthlyAumDisclosure>> | null = null;
    try {
      feeDisclosureResult = await runMonthlyFeeDisclosure();
    } catch (e: any) {
      feeDisclosureResult = { ok: false, skipped: false, reason: String(e?.message ?? e) };
    }
    try {
      aumDisclosureResult = await runMonthlyAumDisclosure();
    } catch (e: any) {
      aumDisclosureResult = { ok: false, skipped: false, reason: String(e?.message ?? e) };
    }
    // 2026-10-31（使用者核准）: FundClear 年度報酬率/年度費用率（query-rate）也併進這支既有cron，
    // 只處理「只有一個級別」的境內基金。獨立開關 FUNDCLEAR_ANNUAL_WRITE，shadow模式預設不寫入，
    // 失敗不影響上面每日NAV同步跟SITCA月揭露的結果判定。
    let fundclearAnnualResult: Awaited<ReturnType<typeof runFundclearAnnualSync>> | null = null;
    try {
      fundclearAnnualResult = await runFundclearAnnualSync();
    } catch (e: any) {
      fundclearAnnualResult = { ok: false, skipped: false, reason: String(e?.message ?? e) };
    }
    let fundclearAumGapFillResult: Awaited<ReturnType<typeof runFundclearAumGapFill>> | null = null;
    try {
      fundclearAumGapFillResult = await runFundclearAumGapFill();
    } catch (e: any) {
      fundclearAumGapFillResult = { ok: false, skipped: false, reason: String(e?.message ?? e) };
    }
    // 2026-11-03（使用者核准）: funds.company 回補也併進這支既有cron，重用同一次已經抓到的rows，
    // 不另外發SITCA請求。獨立開關 FUND_COMPANY_BACKFILL_WRITE，shadow模式預設不寫入，只補空白、
    // 不覆蓋既有值，失敗不影響上面其他結果判定。
    let companyBackfillResult: Awaited<ReturnType<typeof runFundCompanyBackfill>> | null = null;
    try {
      companyBackfillResult = await runFundCompanyBackfill(rows);
    } catch (e: any) {
      companyBackfillResult = { ok: false, skipped: false, reason: String(e?.message ?? e) };
    }
    // 2026-11-04（使用者核准，cron數量上限95，併進這支既有的hourly sitca-nav-sync，不新增
    // cron）：野村公開說明書費率同步(抓61筆MOPS申報+PDF解析，實測要幾分鐘)跟這支主流程(每小時
    // 300秒預算、已經有5個子步驟)放在一起直接跑不安全，所以用自己的run_key(day粒度)先做
    // once-a-day的gate——同一天第一次呼叫sitca-nav-sync就會真的開始跑，之後23次整點呼叫因為
    // run_key已存在而skip。deadline只留給這一次「當天第一次」呼叫最多120秒（sitca-nav-sync
    // 自己main流程+上面4個子步驟實測都在幾十秒內完成，120秒給費率同步、剩下至少180秒安全邊界
    // 給maxDuration=300秒），processed不完的用checkpoint記住，下一個整點（還是同一天）接著跑。
    let nomuraFeeResult: Awaited<ReturnType<typeof runNomuraProspectusFeeSync>> | null = null;
    // maxDuration=300秒，留20秒安全緩衝；這一步最多再用120秒，兩者取小的，確保不會把整支route
    // 的總時間預算用完——沒有足夠時間就完全不呼叫beginRun，避免留下一筆開了頭卻沒收尾的
    // IN_PROGRESS紀錄。
    const feeDeadline = Math.min(startedMs + 280_000, Date.now() + 120_000);
    if (feeDeadline - Date.now() > 10_000) {
      const feeDayKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const feeRunKey = `fund-prospectus-fee-sync-daily-${feeDayKey}`;
      const feeGate = await beginRun({
        jobName: "FUND_PROSPECTUS_FEE_SYNC", provider: "NOMURA_MOPS", runKey: feeRunKey,
        universeCount: 0, batchSize: 0, checkpointBefore: null,
      });
      if (!feeGate.skipped) {
        // 2026-10-23同一支route曾經因為例外沒被catch、finishRun從沒被呼叫，production_scheduler_
        // runs那筆紀錄永遠卡在IN_PROGRESS——這裡try/catch兩條路都要呼叫finishRun，不能只在
        // 成功路徑收尾。
        try {
          nomuraFeeResult = await runNomuraProspectusFeeSync(feeDeadline);
          await finishRun(feeGate.runId, "FUND_PROSPECTUS_FEE_SYNC", "NOMURA_MOPS", startedMs, {
            status: "COMPLETED", attempted: nomuraFeeResult.attempted, completed: nomuraFeeResult.matched,
            inserted: nomuraFeeResult.written, updated: 0, failed: nomuraFeeResult.failed.length,
            retryableFailures: 0, checkpointAfter: null,
            details: { attempted: nomuraFeeResult.attempted, matched: nomuraFeeResult.matched, written: nomuraFeeResult.written, failedCount: nomuraFeeResult.failed.length, reachedEnd: nomuraFeeResult.reachedEnd },
          });
        } catch (e: any) {
          nomuraFeeResult = { ok: false, skipped: false, reason: String(e?.message ?? e) } as any;
          await finishRun(feeGate.runId, "FUND_PROSPECTUS_FEE_SYNC", "NOMURA_MOPS", startedMs, {
            status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1,
            retryableFailures: 1, checkpointAfter: null, error: String(e?.message ?? e),
          });
        }
      }
    }

    // 2026-11-05使用者核准：境內基金經理人（基金資訊觀測站）也併進這支既有cron（每小時一次，
    // vercel.json "33 * * * *"），不新增cron。跟Nomura費率同步不同——這裡故意不做「一天只跑
    // 一次」的gate：577組（基金層級分組，同一檔基金的級別共用一次請求）要分好幾天才能跑完整個
    // 缺口，runFundclearManagerSync()自己的runKey已經把checkpoint游標的startIndex編進去，
    // 每次呼叫游標往前推進、runKey自然不同，所以本來就會每小時真的執行一次（不是只有當天
    // 第一次）；真的被擋（401/403/429）時runKey停在同一個startIndex，同一小時內重複呼叫會被
    // beginRun的run_key去重擋下，隔天(today變了)才會再試一次——避免被擋後still一直重試。
    // 無頭瀏覽器一組約2~10秒，用剩餘時間預算的子集，確保不會把maxDuration=300秒的整支route
    // 時間用完。
    let managerSyncResult: Awaited<ReturnType<typeof runFundclearManagerSync>> | null = null;
    const managerDeadline = Math.min(startedMs + 280_000, Date.now() + 90_000);
    if (managerDeadline - Date.now() > 10_000) {
      try {
        managerSyncResult = await runFundclearManagerSync(managerDeadline);
      } catch (e: any) {
        managerSyncResult = { ok: false, skipped: false, reason: String(e?.message ?? e) } as any;
      }
    }

    const matchedByCode = matched.filter((m) => m.matchedBy === "CODE").length;
    const matchedByName = matched.filter((m) => m.matchedBy === "NAME").length;

    // 2026-10-22（使用者核准，三.三稽核發現）: 之前不論write_error_count或matched數量掉到0都無
    // 條件回報COMPLETED。
    // 2026-11-02（VERIFIED，健康報告LAST_RUN_PARTIAL永久誤報修正）: 下面written===0的PARTIAL
    // 條件撞到CLAUDE.md的資料新鮮度規則——VERIFIED過去24小時全部24次執行written全部是0、
    // unmatched_count/currency_mismatch_count/unit_mismatch_count/jump_review_count/
    // write_error_count全部是0、matched_count穩定在36或4306（視當次hour有無完整CSV而定），這是
    // SITCA官方CSV本身還沒發布新一天NAV時的正常穩態（writeSitcaNavBatch本身設計成不預先濾掉
    // 「已經最新」的候選、讓UPDATE的WHERE子句去判斷，見navWriter.ts開頭註解），不是寫入失敗。
    // 原本的written===0規則把這個健康穩態跟真正的寫入失敗混在一起，導致這個job只要資料已經追上
    // 官方最新進度，健康報告就會永久誤報LAST_RUN_PARTIAL，天天出現在SYSTEM異常清單。拿掉這條，
    // 只留write_error_count>0（真正的寫入失敗）當PARTIAL的判斷依據；unmatched/currency/unit
    // mismatch增加時，health report自己另外有獨立的core_universe_fund覆蓋率檢查會抓到，不需要
    // 靠這裡的status欄位重複示警。
    const status = writeResult.writeErrorCount > 0 ? "PARTIAL" : "COMPLETED";
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
        fee_disclosure: feeDisclosureResult, aum_disclosure: aumDisclosureResult,
        fundclear_annual: fundclearAnnualResult, fundclear_aum_gap_fill: fundclearAumGapFillResult,
        company_backfill: companyBackfillResult,
        nomura_prospectus_fee: nomuraFeeResult,
        fundclear_manager_sync: managerSyncResult,
      },
    });

    return Response.json({
      ok: true, job: JOB, runId, status, runMode: currentRunMode(),
      csvRowCount: rows.length, twdFundCount: fundRows.length,
      matchedCount: matched.length, matchedByCode, matchedByName, unmatchedCount: unmatched.length,
      currencyMismatchCount, unitMismatchCount, jumpReviewCount, writeCandidateCount: candidates.length,
      written: writeResult.written, writeErrorCount: writeResult.writeErrorCount,
      feeDisclosure: feeDisclosureResult, aumDisclosure: aumDisclosureResult,
      fundclearAnnual: fundclearAnnualResult, fundclearAumGapFill: fundclearAumGapFillResult,
      companyBackfill: companyBackfillResult,
      nomuraProspectusFee: nomuraFeeResult,
      fundclearManagerSync: managerSyncResult,
    });
  } catch (e: any) {
    await finishRun(runId, JOB, "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV", startedMs, {
      status: "FAILED", attempted: rows.length, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      error: String(e?.message ?? e), checkpointAfter: null,
      details: { run_mode: currentRunMode(), stage: "post-fetch" },
    });
    return Response.json({ ok: false, job: JOB, runId, status: "FAILED", error: String(e?.message ?? e) }, { status: 502 });
  }
}
