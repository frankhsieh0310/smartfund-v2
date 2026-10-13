// Function 5 (配息目標試算) — ETF side. Rewritten to use ONLY the Yahoo-direct distribution yield
// (lib/yahoo/distributionYield.ts — the same shared layer Function 6's ranking uses). No more
// trailing-12M/price, no frequency inference, no "estimated" fallback: those were a self-calculated
// yield, which is no longer permitted here. If Yahoo has not published a yield for an ETF, it is
// simply absent from `assets` — never guessed.
import { getEtfYahooYieldRanking } from "@/lib/yahoo/distributionYield";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET() {
  const rows = await getEtfYahooYieldRanking(500);
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
