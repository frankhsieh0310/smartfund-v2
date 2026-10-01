// Function 6 (配息率排行榜) — ETF + 基金 ranking, both using the ONE shared Yahoo-direct yield layer
// (lib/yahoo/distributionYield.ts). No self-calculated yield, no 12M/price, no 12M/NAV, no
// annualization, no estimation. Ranking value IS the Yahoo value.
import { prisma } from "@/lib/prisma";
import { getEtfYahooYieldRanking } from "@/lib/yahoo/distributionYield";
import { readFundYieldSnapshot, fundYieldPage } from "@/lib/yahoo/fundYieldRanking";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const code = q.get("code");
  const type = q.get("type") === "fund" ? "fund" : "etf";

  if (code) {
    if (type === "fund") {
      // No self-calculated history/yield for funds — honest: nothing to show until Yahoo provides a
      // direct fund distribution history source (not built here, per scope).
      return Response.json({ code, history: [] }, { headers });
    }
    // 歷次配息紀錄 — informational only, real official rows, never used to compute the ranking yield.
    const rows = await prisma.$queryRawUnsafe<Array<{
      ex_date: string; payment_date: string | null; announcement_date: string | null;
      amount: string; currency: string; distribution_type: string | null; source: string;
    }>>(
      `SELECT d.ex_date::text, d.payment_date::text, d.announcement_date::text,
              d.amount::text, d.currency, d.distribution_type, d.source
         FROM etf_distribution_events d JOIN etfs e ON e.id = d.etf_id
        WHERE e.code = $1
        ORDER BY d.ex_date DESC LIMIT 60`,
      code,
    );
    return Response.json({
      code,
      history: rows.map((r) => ({
        exDate: r.ex_date, paymentDate: r.payment_date, announcementDate: r.announcement_date,
        amount: Number(r.amount), currency: r.currency, distributionType: r.distribution_type, source: r.source,
      })),
    }, { headers });
  }

  const limit = Math.min(500, Math.max(1, Math.trunc(Number(q.get("limit")) || 50)));
  const offset = Math.max(0, Math.trunc(Number(q.get("offset")) || 0));
  if (type === "fund") {
    try {
      const snapshot = await readFundYieldSnapshot();
      if (q.get("snapshot") && q.get("snapshot") !== snapshot.version) return Response.json({error:"RANKING_CHANGED"},{status:409,headers});
      return Response.json(fundYieldPage(snapshot,offset,limit),{headers});
    } catch {
      return Response.json({error:"完整基金配息率排行尚未就緒"},{status:503,headers});
    }
  }
  const rows = await getEtfYahooYieldRanking(limit);

  return Response.json({
    type,
    data: rows.filter(r => r.yahooYieldPct != null).map((r) => ({
      code: r.code, name: r.name, yahooYield: r.yahooYieldPct,
      latestDividend: r.latestDividend, exDate: r.latestExDate,
    })),
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
