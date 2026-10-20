// TEMPORARY, read-only diagnostic for the 2026-10-20 iad1-vs-sin1 region measurement -- not one of
// the real cron routes, never scheduled (no vercel.json entry), does 5 sequential trivial SELECTs
// (no writes) and reports per-query timing plus a region marker. Deleted once the measurement is done.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const timings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await prisma.$queryRawUnsafe(`SELECT 1`);
    timings.push(Date.now() - t0);
  }
  return Response.json({ ok: true, region: process.env.VERCEL_REGION ?? "unknown", timingsMs: timings, avgMs: timings.reduce((a, b) => a + b, 0) / timings.length });
}
