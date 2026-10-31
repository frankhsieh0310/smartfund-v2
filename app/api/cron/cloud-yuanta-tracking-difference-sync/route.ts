// ETF追蹤差距 — copies Yuanta's own official number verbatim (lib/etf-holdings-engine/adapters/
// yuantaTrackingDifference.ts), scoped to the hand-verified TRACKED_YUANTA_FUND_IDS table (matched
// by ETF code, never by Chinese name). Storage: etf_tracking_difference (dedicated table, see
// migration SQL from 2026-10-30 "淨值欄顯示異常" fix).
//
// 2026-10-30（使用者核准，淨值欄顯示異常修正）: 這支原本把追蹤差距寫進 etf_asset_metrics.nav
// （用 source_record_id 當判別欄位），結果被 ETF 列表頁的 nav query（DISTINCT ON etf_id ORDER BY
// observation_date DESC）隨便撿到，顯示成離譜的「淨值 -1.47」。追蹤差距跟淨值是完全不同的兩個數字，
// 不能共用同一個generic value欄位 — 改用專屬的 etf_tracking_difference 表，不再寫 etf_asset_metrics。
//
// SHADOW MODE BY DEFAULT: unless YUANTA_TRACKING_DIFFERENCE_SYNC_WRITE is exactly "on", fetches and
// parses but writes nothing.
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { fetchAllYuantaTrackingDifferences, TRACKED_YUANTA_FUND_IDS } from "@/lib/etf-holdings-engine/adapters/yuantaTrackingDifference";
import { isYuantaTrackingDifferenceSyncWriteEnabled } from "@/lib/cron/yuantaTrackingDifferenceWriteGate";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "YUANTA_TRACKING_DIFFERENCE_SYNC";
const PROVIDER = "YUANTA_OFFICIAL";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const writeEnabled = isYuantaTrackingDifferenceSyncWriteEnabled();
  const runKey = `${JOB}:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: Object.keys(TRACKED_YUANTA_FUND_IDS).length, batchSize: Object.keys(TRACKED_YUANTA_FUND_IDS).length, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  try {
    const diffs = await fetchAllYuantaTrackingDifferences();
    let written = 0, missing = 0;
    const results: Array<{ code: string; deviation: number; lsdeviation: number; asOfDate: string }> = [];

    for (const [fundId, code] of Object.entries(TRACKED_YUANTA_FUND_IDS)) {
      const d = diffs.get(fundId);
      if (!d) { missing++; continue; }
      const etf = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM etfs WHERE code = $1`, code);
      if (!etf.length) { missing++; continue; }
      results.push({ code, deviation: d.deviation, lsdeviation: d.lsdeviation, asOfDate: d.asOfDate });
      if (writeEnabled) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO etf_tracking_difference (id, etf_id, observation_date, daily_pct, cumulative_pct, source, source_url, retrieved_at, created_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2::date, $3, $4, 'YUANTA_OFFICIAL', 'https://www.yuantaetfs.com/tradeInfo/trackingDifference/ETF', NOW(), NOW(), NOW())
           ON CONFLICT (etf_id, observation_date, source) DO UPDATE SET daily_pct = EXCLUDED.daily_pct, cumulative_pct = EXCLUDED.cumulative_pct, updated_at = NOW()`,
          etf[0].id, d.asOfDate, d.deviation, d.lsdeviation,
        );
        written++;
      }
    }

    await finishRun(runId, JOB, PROVIDER, startedMs, {
      status: "COMPLETED", attempted: Object.keys(TRACKED_YUANTA_FUND_IDS).length, completed: written, inserted: written, updated: 0, failed: missing, retryableFailures: 0,
      checkpointAfter: null, details: { writeEnabled, results, missing },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled, written, missing, results });
  } catch (error) {
    // 2026-10-31（使用者核准）: 元大官網週末/休市或當天還沒更新頁面時，__NUXT__ state裡的
    // data[0].allData本來就是空的（YUANTA_TD_NO_ALLDATA）——這是「資料來源還沒有新資料」，不是
    // 我們這邊的錯誤，不該跟真正的抓取失敗一樣算FAILED。這裡只認這一個已知的「無新資料」訊號，
    // 其他任何錯誤仍然照舊算FAILED，不擴大解釋。
    const message = (error as Error).message;
    const isNoNewDataYet = message.includes("YUANTA_TD_NO_ALLDATA");
    await finishRun(runId, JOB, PROVIDER, startedMs, {
      status: isNoNewDataYet ? "SKIPPED" : "FAILED",
      attempted: 0, completed: 0, inserted: 0, updated: 0, failed: isNoNewDataYet ? 0 : 1,
      retryableFailures: isNoNewDataYet ? 0 : 1, checkpointAfter: null, error: message,
      details: isNoNewDataYet ? { skipped_reason: "EXTERNAL_DELAY_NO_NEW_DATA" } : undefined,
    });
    return Response.json({ ok: true, job: JOB, skipped: isNoNewDataYet, reason: isNoNewDataYet ? "EXTERNAL_DELAY_NO_NEW_DATA" : undefined, error: isNoNewDataYet ? undefined : message }, { status: isNoNewDataYet ? 200 : 500 });
  }
}
