// TEMPORARY, read-only diagnostic for the 2026-10-20 iad1-vs-sin1 region measurement -- not one of
// the real cron routes, never scheduled (no vercel.json entry), does 5 sequential trivial SELECTs
// (no writes) and reports per-query timing plus a region marker. Deleted once the measurement is done.
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// CRON_SECRET isn't configured for Preview (by design -- a production secret shouldn't be handed to
// preview deployments), so this diagnostic-only probe reuses LOCAL_SCHEDULE_REPORT_SECRET instead
// (already confirmed set on both Preview and Production this session) purely to measure real DB round
// trips from each region. Deleted along with this whole route once the measurement is done.
export async function GET(request: Request) {
  const secret = process.env.LOCAL_SCHEDULE_REPORT_SECRET;
  const header = request.headers.get("authorization") ?? "";
  if (!secret || header !== `Bearer ${secret}`) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const timings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await prisma.$queryRawUnsafe(`SELECT 1`);
    timings.push(Date.now() - t0);
  }
  return Response.json({ ok: true, region: process.env.VERCEL_REGION ?? "unknown", timingsMs: timings, avgMs: timings.reduce((a, b) => a + b, 0) / timings.length });
}
