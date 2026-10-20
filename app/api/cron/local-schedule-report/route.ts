// Local-schedule self-report endpoint (2026-10-20). Lets a trusted Windows Scheduled Task on the
// user's own machine (which never calls any Vercel cron, has nothing of its own to GET-authorize)
// report its own success/failure into THIS database's production_scheduler_runs, so
// local-schedule-monitor and daily-health-report's checkLocalScheduleReporting can see it.
//
// Covers (today, see each caller for how it's wired in):
//   LOCAL_1330_TW_PRICE_UPDATE / LOCAL_1500_INSTITUTIONAL_UPDATE / LOCAL_1700_TW_DATA_FINAL_UPDATE
//     -- tw-industry-radar\scripts\run-scheduled-update.mjs (one shared script, all three tasks)
// Not yet wired (see CLAUDE.md for the pattern to replicate): OpenClaw Gateway,
// tw-etf-lookup-api's 摩根持股匯入/Mega uploader -- different repos, same endpoint + secret can be
// reused once each one's own script is updated to call it.
//
// Same trust-boundary reasoning as etf-official-holdings-mega-desktop-ingest's own dedicated secret:
// this accepts a POST from an external process, not a bare authorized GET, so it gets its own secret
// (LOCAL_SCHEDULE_REPORT_SECRET) rather than reusing CRON_SECRET -- a leak here can only ever let
// someone write fake run-log rows, never touch holdings/price/fund data.
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 15;
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 10_000;
const ALLOWED_JOB_IDS = new Set([
  "LOCAL_1330_TW_PRICE_UPDATE",
  "LOCAL_1500_INSTITUTIONAL_UPDATE",
  "LOCAL_1700_TW_DATA_FINAL_UPDATE",
  "LOCAL_OPENCLAW_GATEWAY",
  "LOCAL_TW_ETF_LOOKUP_MORGAN_IMPORT",
  "LOCAL_TW_ETF_LOOKUP_MEGA_UPLOADER",
]);

function isAuthorized(request: Request): boolean {
  const secret = process.env.LOCAL_SCHEDULE_REPORT_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) return Response.json({ ok: false, error: "Payload too large" }, { status: 413 });

  let body: { jobId?: string; status?: string; detail?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { jobId, status, detail } = body;
  if (!jobId || !ALLOWED_JOB_IDS.has(jobId)) {
    return Response.json({ ok: false, error: `jobId must be one of: ${[...ALLOWED_JOB_IDS].join(", ")}` }, { status: 400 });
  }
  if (status !== "COMPLETED" && status !== "FAILED") {
    return Response.json({ ok: false, error: "status must be COMPLETED or FAILED" }, { status: 400 });
  }
  const detailText = typeof detail === "string" ? detail.slice(0, 2000) : null;

  await prisma.$executeRawUnsafe(
    `INSERT INTO production_scheduler_runs
       (id, job_id, exchange, run_type, status, started_at, completed_at, universe_count, details, attempted, completed, inserted, updated, failed, error)
     VALUES (gen_random_uuid(), $1, 'LOCAL', 'LOCAL_SCHEDULE_SELF_REPORT', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, $3::jsonb, 1, $4, 0, 0, $5, $6)`,
    jobId,
    status,
    JSON.stringify({ reported_detail: detailText }),
    status === "COMPLETED" ? 1 : 0,
    status === "FAILED" ? 1 : 0,
    status === "FAILED" ? (detailText ?? "FAILED") : null,
  );

  return Response.json({ ok: true, jobId, status });
}
