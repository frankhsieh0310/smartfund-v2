// Cloud watchdog for the Mega ETF holdings desktop-fallback path (Mega's own site blocks cloud/
// datacenter egress, so this one source has to stay a Windows Scheduled Task on the user's own
// machine -- see CLAUDE.md "正式資料排程一律在雲端執行" exception). Runs daily at 21:00 Taipei,
// well after the task's own 19:35 schedule, and checks whether it actually reported into
// production_scheduler_runs today. Missing -> Telegram alert naming which schedule and when it
// last succeeded, so a silent desktop-side failure (machine off, task disabled, reboot mid-run)
// gets caught the same evening instead of surfacing days later as stale holdings data.
//
// 2026-10-20: also watches tw-industry-radar's 1330/1500/1700 now, via the new
// local-schedule-report/route.ts endpoint (run-scheduled-update.mjs calls it after each run).
// OpenClaw Gateway and tw-etf-lookup-api's uploaders are separate products whose own scripts don't
// call that endpoint yet -- the endpoint already accepts their job ids (see its ALLOWED_JOB_IDS),
// but they're deliberately left out of WATCHED below until each script is actually updated, to
// avoid a false "never reported" alert for something that was never wired to report in the first
// place.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { notifyAnomaly } from "@/lib/daily-health-report/notify";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const JOB = "LOCAL_SCHEDULE_MONITOR";

type WatchedSchedule = { label: string; jobIdPrefix: string };
const WATCHED: WatchedSchedule[] = [
  { label: "SmartMatch Mega ETF Holdings（兆豐 ETF 官方持股桌機排程）", jobIdPrefix: "ETF_OFFICIAL_HOLDINGS_MEGA_DESKTOP:" },
  { label: "1330 TW Price Update（tw-industry-radar）", jobIdPrefix: "LOCAL_1330_TW_PRICE_UPDATE" },
  { label: "1500 Institutional Update（tw-industry-radar）", jobIdPrefix: "LOCAL_1500_INSTITUTIONAL_UPDATE" },
  { label: "1700 TW Data Final Update（tw-industry-radar）", jobIdPrefix: "LOCAL_1700_TW_DATA_FINAL_UPDATE" },
  { label: "OpenClaw Gateway（tw-data-updater 本機長駐 daemon）", jobIdPrefix: "LOCAL_OPENCLAW_GATEWAY" },
  { label: "tw-etf-lookup 摩根持股匯入", jobIdPrefix: "LOCAL_TW_ETF_LOOKUP_MORGAN_IMPORT" },
  { label: "tw-etf-lookup Mega uploader", jobIdPrefix: "LOCAL_TW_ETF_LOOKUP_MEGA_UPLOADER" },
];

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const runKey = `local-schedule-monitor:${today}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL_WATCHDOG", runKey, universeCount: WATCHED.length, batchSize: WATCHED.length, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "already ran today", runKey });

  const results: Array<{ label: string; reportedToday: boolean; lastSuccessAt: string | null }> = [];
  for (const w of WATCHED) {
    const todayRows = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int n FROM production_scheduler_runs
        WHERE job_id LIKE $1 AND status IN ('COMPLETED','PARTIAL') AND started_at >= CURRENT_DATE`,
      `${w.jobIdPrefix}%`,
    );
    const lastSuccessRow = await prisma.$queryRawUnsafe<{ started_at: string }[]>(
      `SELECT started_at::text FROM production_scheduler_runs
        WHERE job_id LIKE $1 AND status IN ('COMPLETED','PARTIAL')
        ORDER BY started_at DESC LIMIT 1`,
      `${w.jobIdPrefix}%`,
    );
    results.push({ label: w.label, reportedToday: todayRows[0].n > 0, lastSuccessAt: lastSuccessRow[0]?.started_at ?? null });
  }

  const missing = results.filter((r) => !r.reportedToday);
  let notifyResult = null;
  if (missing.length > 0) {
    const lines = missing.map((m) => `- ${m.label}：今天沒有回報成功紀錄。最後一次成功：${m.lastSuccessAt ?? "從未成功過"}`);
    const summary = `⚠️ 本機排程未回報（${today} 21:00 台北時間檢查）\n${lines.join("\n")}`;
    notifyResult = await notifyAnomaly(summary);
  }

  await finishRun(runId, JOB, "INTERNAL_WATCHDOG", startedMs, {
    status: missing.length > 0 ? "PARTIAL" : "COMPLETED",
    attempted: WATCHED.length, completed: WATCHED.length - missing.length, inserted: 0, updated: 0,
    failed: missing.length, retryableFailures: 0, checkpointAfter: null,
    details: { date: today, results, missing_count: missing.length, notify_result: notifyResult },
  });

  return Response.json({ ok: true, job: JOB, runId, results, missingCount: missing.length, notifyResult });
}
