// TEMPORARY -- one-off probe to verify fred.stlouisfed.org's keyless CSV endpoint is reachable from
// this function's actual deployed region (sin1), not just from the developer's own machine. Deleted
// again right after the real-sin1 check that justifies the daily-health-report FRED fix. Same
// pattern as the earlier region-latency-probe route.
export const runtime = "nodejs";
export const maxDuration = 15;
export const dynamic = "force-dynamic";

export async function GET() {
  const results: Record<string, unknown> = {};
  for (const id of ["DCOILWTICO", "DHHNGSP"]) {
    const started = Date.now();
    try {
      const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      const lastLine = text.trim().split("\n").at(-1);
      results[id] = { ok: res.ok, status: res.status, elapsedMs: Date.now() - started, lastLine };
    } catch (e) {
      results[id] = { ok: false, error: e instanceof Error ? e.message : String(e), elapsedMs: Date.now() - started };
    }
  }
  return Response.json({ region: process.env.VERCEL_REGION ?? null, results });
}
