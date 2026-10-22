// Function 5 (配息目標試算) — Fund side. Same shared Yahoo-direct yield layer as the ETF route
// (lib/yahoo/distributionYield.ts) and Function 6's fund ranking. No NAV-based self-calculation, no
// dividend-events/NAV math or production writes. Direct Yahoo reads use exact provider mapping.
import { getFundYahooYieldRanking } from "@/lib/yahoo/distributionYield";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const offset = Math.max(0, Math.trunc(Number(new URL(request.url).searchParams.get("offset")) || 0));
  const limit = Math.min(50, Math.max(1, Math.trunc(Number(new URL(request.url).searchParams.get("limit"))) || 50));
  const rows = await getFundYahooYieldRanking(limit, offset);
  return Response.json({
    assets: rows.map((r) => ({
      symbol: r.code, name: r.name,
      yahoo_yield_pct: r.yahooYieldPct,
      latest_distribution_amount: r.latestDividend,
      latest_distribution_date: r.latestExDate,
    })),
    generated_at: new Date().toISOString(),
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
