// ETF追蹤差距 — copies Yuanta's own official number verbatim (lib/etf-holdings-engine/adapters/
// yuantaTrackingDifference.ts), scoped to the hand-verified TRACKED_YUANTA_FUND_IDS table (matched
// by ETF code, never by Chinese name). Storage: etf_asset_metrics, no schema change — this table
// has no flexible metric-type column, so `source_record_id` is repurposed as the metric
// discriminator and `nav` as the generic value slot (documented below and in the adapter file),
// per the user's explicit "不要新增欄位，存在既有的etf_asset_metrics" instruction.
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
        for (const [recordId, value] of [["YUANTA_TRACKING_DIFFERENCE_DAILY", d.deviation], ["YUANTA_TRACKING_DIFFERENCE_CUMULATIVE", d.lsdeviation]] as const) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO etf_asset_metrics (id, etf_id, observation_date, nav, currency, source, source_record_id, source_url, retrieved_at, verification_status, created_at, updated_at)
             VALUES (gen_random_uuid()::text, $1, $2::date, $3, 'TWD', 'YUANTA_OFFICIAL', $4, 'https://www.yuantaetfs.com/tradeInfo/trackingDifference/ETF', NOW(), 'VERIFIED_OFFICIAL', NOW(), NOW())
             ON CONFLICT (etf_id, observation_date, source, source_record_id) DO UPDATE SET nav = EXCLUDED.nav, updated_at = NOW()`,
            etf[0].id, d.asOfDate, value, recordId,
          );
        }
        written++;
      }
    }

    await finishRun(runId, JOB, PROVIDER, startedMs, {
      status: "COMPLETED", attempted: Object.keys(TRACKED_YUANTA_FUND_IDS).length, completed: written, inserted: written, updated: 0, failed: missing, retryableFailures: 0,
      checkpointAfter: null, details: { writeEnabled, results, missing },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled, written, missing, results });
  } catch (error) {
    await finishRun(runId, JOB, PROVIDER, startedMs, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (error as Error).message });
    return Response.json({ ok: false, job: JOB, error: (error as Error).message }, { status: 500 });
  }
}
