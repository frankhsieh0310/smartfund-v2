// Batch-updates the ~3,711 "approved by TDCC but not syncing" offshore funds (found by this round's
// QA audit -- see docs/specs/offshore-fund-classification.md) from TDCC's own official single-file
// open-data NAV export (lib/offshore-nav-sync/tdccBatchSource.ts), instead of scraping Yahoo奇摩
// individually for each one (~3.3s/fund x 3,711 funds would be 1.4-3.4 hours/day, see that same doc).
// One HTTP GET covers the whole universe, so this is cheap enough to run on Vercel on a normal cron
// schedule -- no desktop Task Scheduler fallback needed.
//
// Only touches funds this job can identify with HIGH confidence: an EXACT fund-name match against the
// CSV, scoped to funds.data_provider = 'yahoo' (the already-known stale population) so this never
// touches a fund some other pipeline owns. Uses the SAME fund_history + funds.latest_nav* write target
// as the existing offshore-nav-sync (lib/offshore-nav-sync/navWriter.ts's forward-only-date rule), via
// a dedicated writeTdccNavBatch that tags last_nav_source = 'TDCC_OPENDATA_NAV' instead of
// 'YAHOO_FUND_PRICE_HISTORY', so the two sources are never confused in later audits.
//
// SHADOW MODE BY DEFAULT: unless OFFSHORE_NAV_TDCC_SYNC_WRITE is exactly "on", fetches/matches but
// writes nothing. Scheduled twice daily at 10:30/18:30 Taipei (vercel.json) -- opening the write path
// is still a separate, explicit user decision made after confirming a clean first shadow run. Manually
// cross-checked 2 funds live against fundclear.com.tw's own search UI 2026-10-14 (both exact match) --
// see lib/offshore-nav-sync/tdccBatchSource.ts's header comment.
//
// Fund-ownership split from offshore-nav-sync (round-4, user-approved): offshore-nav-sync's own
// 876-fund Yahoo mapping (lib/offshore-nav-sync/mapping.ts's loadMapping()) is the pre-existing,
// actively-synced population -- this job explicitly excludes every fundId in that mapping, so the same
// fund is never written by both pipelines. See lib/offshore-nav-sync/tdccBatchSource.ts's
// excludeOverlapWithYahooMapping() and its test.
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { fetchTdccNavCsv, parseTdccNavCsv, parseTdccNavCsvRows, excludeOverlapWithYahooMapping, filterNewerThanStored, filterNewerThanStoredByCode, indexByCode, TDCC_NAV_SOURCE } from "@/lib/offshore-nav-sync/tdccBatchSource";
import { writeTdccNavBatch } from "@/lib/offshore-nav-sync/navWriter";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import { runOffshoreScaleSync } from "@/lib/offshore-scale-sync/writer";
import { runOffshoreTwHoldingSync } from "@/lib/offshore-scale-sync/twHoldingWriter";

export const runtime = "nodejs";
// Raised from 60s this round: the 2026-10-15 10:31 UTC production run (first real run after this
// round's fund-107 code-matched candidate branch was added, write-enabled) got hard-killed by
// Vercel before ever reaching the catch block -- confirmed via production_scheduler_runs: the row
// is still stuck at status=IN_PROGRESS with attempted=0 hours later, which is exactly what
// beginRun's initial insert looks like before the route does any work. Writing ~3,700 name-matched
// rows plus the new code-matched branch within 60s (CSV fetch + 2 candidate queries against a
// ~23,700-row combined pool + the write transaction) was too tight. 280s matches every other
// heavy ingestion route in this codebase (yahoo-commodity, yahoo-index, yahoo-crypto all use
// 280-300s).
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "OFFSHORE_NAV_TDCC_SYNC";
const query = (sql: string, params: any[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function isWriteEnabled(): boolean {
  return process.env.OFFSHORE_NAV_TDCC_SYNC_WRITE?.trim() === "on";
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();
  const today = new Date().toISOString().slice(0, 10);

  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: TDCC_NAV_SOURCE, runKey: `${JOB}:${today}`, universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true });

  // Task X8: no more `updated_at < 14 days ago` filter here -- every data_provider='yahoo' fund is a
  // candidate every run, and filterNewerThanStored() below (plus navWriter.ts's own SQL-level guard)
  // decides writability purely by comparing the CSV's navDate against the fund's own stored
  // latest_nav_date, so a fund with a genuinely newer NAV is never stuck waiting out a staleness
  // window again.
  //
  // 2026-10-21（使用者核准）: VERIFIED live -- the name-matched population below was scoped to
  // data_provider='yahoo' only, so a tdcc-offshore fund with NO `code` (443 of the 520-fund gap in
  // core_universe_fund's tdcc-offshore slice, ~85%) had no path into EITHER branch here at all: not
  // the code-matched branch (requires code IS NOT NULL) and not this one (wrong data_provider).
  // Cross-checked all 443 against this same CSV by exact name -- every single one has a real,
  // non-"-9999" NAV sitting right there. Added `data_provider = 'tdcc-offshore' AND code IS NULL` to
  // this query (name-matching only, since these funds have no code to match by) fixes exactly that
  // gap without touching the code-matched branch's own population (code IS NOT NULL) at all.
  // 2026-10-31（使用者核准，商品範圍最高原則）: VERIFIED這兩條候選查詢合計37,672檔裡96.3%
  // (36,272檔)根本不是APPROVED——每輪都把CSV比對結果寫進這些範圍外基金的latest_nav/
  // fund_history，完全是浪費（使用者永遠看不到這些商品）。補上APPROVED過濾，兩條都只保留
  // 「台灣買得到」的候選。
  // 2026-11-02（VERIFIED，使用者核准，新上市基金NAV backfill卡住修正）: 兩條候選SQL都加上
  // hasHistory（fund_history是否已經有至少一列），讓filterNewerThanStored/ByCode()能分辨「latest_
  // nav_date看起來不比CSV舊」是「真的已經同步過」還是「CLOUD_NEW_FUND_LISTING_DETECTION建檔時
  // 直接種了latest_nav_date、但從來沒寫過fund_history」——後者即使日期比較不過，也要放行一次。
  const [rawCandidateFunds, codeCandidateFunds, yahooMapping] = await Promise.all([
    query(`SELECT id, name, latest_nav_date::text AS "latestNavDate", EXISTS(SELECT 1 FROM fund_history h WHERE h.fund_id = funds.id) AS "hasHistory" FROM funds WHERE (data_provider = 'yahoo' OR (data_provider = 'tdcc-offshore' AND code IS NULL)) AND id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`, []),
    // Task (this round): fund 107 and 24 siblings (data_provider='tdcc-offshore') were excluded from
    // every NAV pipeline — this query's old WHERE clause never selected them at all, even though
    // their NAV is sitting in this exact CSV right now. These funds carry TDCC's own 基金代碼
    // directly in `funds.code` (not a name match, which is why the 'yahoo' population above uses
    // name — those funds have no code), so they get their own code-matched branch below rather than
    // being folded into the name-matched population.
    query(`SELECT id, code, latest_nav_date::text AS "latestNavDate", EXISTS(SELECT 1 FROM fund_history h WHERE h.fund_id = funds.id) AS "hasHistory" FROM funds WHERE data_provider = 'tdcc-offshore' AND code IS NOT NULL AND id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`, []),
    loadMapping(query),
  ]);
  const candidateFunds = excludeOverlapWithYahooMapping(rawCandidateFunds, yahooMapping.map((m) => m.fundId));

  const csvText = await fetchTdccNavCsv();
  const byName = parseTdccNavCsv(csvText);
  // 2026-11-05修正：byCode必須從原始逐列資料建索引，不能從已依NAME去重過的byName反推——
  // 否則同NAME、不同總代理各自申報的code，會被另一個總代理較新的那一筆蓋掉整個NAME槽位，
  // 使較舊的那個code從byCode裡完全消失（即使CSV裡那個code本身還在繼續每天申報）。
  // 詳見tdccBatchSource.ts的parseTdccNavCsvRows()/indexByCode()註解（AXAWGRA系列根因）。
  const byCode = indexByCode(parseTdccNavCsvRows(csvText));

  const nameMatchedCount = candidateFunds.filter((f) => byName.has(f.name)).length;
  const codeMatchedCount = codeCandidateFunds.filter((f) => byCode.has(f.code)).length;
  const nameCandidates = filterNewerThanStored(candidateFunds, byName);
  const codeCandidates = filterNewerThanStoredByCode(codeCandidateFunds, byCode);
  const candidates = [...nameCandidates, ...codeCandidates];
  const matched = candidates.length;

  const result = writeEnabled
    ? await writeTdccNavBatch(query, candidates, new Date().toISOString())
    : { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };

  // 2026-10-22（使用者核准，三.三稽核發現）: 之前不論result.writeErrorCount或matched是否掉到0
  // 都無條件回報COMPLETED。
  // 2026-11-03（VERIFIED，健康報告LAST_RUN_PARTIAL誤報修正）: 撞到跟SITCA_NAV_SYNC同一種bug
  // （見app/api/cron/sitca-nav-sync/route.ts那段2026-11-02的註解）——written===0的原因是
  // filterNewerThanStored/ByCode()比對CSV navDate沒有比DB latest_nav_date新，這是TDCC當天
  // 還沒公布新一天NAV時的正常穩態，不是寫入失敗。VERIFIED 2026-11-02 10:31這筆PARTIAL
  // （nameMatchedCount=116, writableRowCount=0），下一次2026-11-03 02:31跑CSV真的更新後
  // writableRowCount=116、自然COMPLETED，證實這不是程式bug。拿掉「matched>0 && written===0」
  // 這條規則，只留write_error_count>0（真正的寫入失敗）當PARTIAL/FAILED的依據。
  const status = result.writeErrorCount > 0 && result.written === 0 ? "FAILED"
    : result.writeErrorCount > 0 ? "PARTIAL"
    : "COMPLETED";
  await finishRun(runId, JOB, TDCC_NAV_SOURCE, startedMs, {
    status, attempted: candidateFunds.length + codeCandidateFunds.length, completed: result.written, inserted: result.written,
    updated: 0, failed: result.writeErrorCount, retryableFailures: 0, checkpointAfter: null,
    details: {
      writeEnabled, rawCandidateCount: rawCandidateFunds.length, yahooMappingExcludedCount: rawCandidateFunds.length - candidateFunds.length,
      candidateCount: candidateFunds.length, csvUniqueFundNames: byName.size, nameMatchedCount, writableRowCount: nameCandidates.length,
      codeCandidateCount: codeCandidateFunds.length, codeMatchedCount, codeWritableRowCount: codeCandidates.length,
    },
  });

  // 2026-10-31（使用者核准）: 境外基金全球規模(TDCC opendata 3-2)併進這支既有的offshore-nav-tdcc
  // -sync排程，不新增cron。獨立開關OFFSHORE_SCALE_WRITE、每天最多查一次，失敗不影響上面淨值
  // 同步的結果判定。
  let offshoreScaleResult: Awaited<ReturnType<typeof runOffshoreScaleSync>> | null = null;
  try { offshoreScaleResult = await runOffshoreScaleSync(); } catch (e: any) { offshoreScaleResult = { ok: false, skipped: false, reason: String(e?.message ?? e) }; }
  // 2026-10-31（使用者核准）: 境外基金國人持有金額(FundClear)也併進這支既有排程，獨立開關
  // OFFSHORE_TW_HOLDING_WRITE，跟上面TDCC全球規模是不同指標、不同表，互不影響彼此的結果判定。
  let offshoreTwHoldingResult: Awaited<ReturnType<typeof runOffshoreTwHoldingSync>> | null = null;
  try { offshoreTwHoldingResult = await runOffshoreTwHoldingSync(); } catch (e: any) { offshoreTwHoldingResult = { ok: false, skipped: false, reason: String(e?.message ?? e) }; }

  return Response.json({
    ok: true, job: JOB, runId, writeEnabled,
    rawCandidateCount: rawCandidateFunds.length, yahooMappingExcludedCount: rawCandidateFunds.length - candidateFunds.length,
    candidateCount: candidateFunds.length, csvUniqueFundNames: byName.size, nameMatchedCount,
    writableRowCount: nameCandidates.length, codeCandidateCount: codeCandidateFunds.length, codeMatchedCount, codeWritableRowCount: codeCandidates.length,
    written: result.written, writeErrorCount: result.writeErrorCount,
    offshoreScale: offshoreScaleResult,
    offshoreTwHolding: offshoreTwHoldingResult,
  });
}
