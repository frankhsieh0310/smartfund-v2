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
  const secret = process.env.LOCAL_SCHEDULE_REPORT_SECRET?.trim();
  const header = (request.headers.get("authorization") ?? "").trim();
  if (!secret) return Response.json({ ok: false, error: "Unauthorized", diag: "secret_env_not_set" }, { status: 401 });
  if (header !== `Bearer ${secret}`) return Response.json({ ok: false, error: "Unauthorized", diag: `secret_len=${secret.length} header_len=${header.length}` }, { status: 401 });
  const timings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await prisma.$queryRawUnsafe(`SELECT 1`);
    timings.push(Date.now() - t0);
  }

  const externalSources = {
    FRED: "https://api.stlouisfed.org/fred/series/observations?series_id=DCOILWTICO&api_key=invalid&file_type=json",
    SEC_EDGAR: "https://data.sec.gov/submissions/CIK0000320193.json",
    Yahoo_Finance: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
    iShares_BlackRock: "https://www.blackrock.com/tw/individual",
  };
  const externalTimings: Record<string, { ms: number; status: number | null; error: string | null }> = {};
  for (const [label, url] of Object.entries(externalSources)) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
      externalTimings[label] = { ms: Date.now() - t0, status: res.status, error: null };
    } catch (e) {
      externalTimings[label] = { ms: Date.now() - t0, status: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return Response.json({ ok: true, region: process.env.VERCEL_REGION ?? "unknown", timingsMs: timings, avgMs: timings.reduce((a, b) => a + b, 0) / timings.length, externalTimings });
}
