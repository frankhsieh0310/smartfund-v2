import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const ticker = q.get("ticker"), securityId = q.get("securityId"), market = q.get("market");
  const startDate = q.get("startDate"), endDate = q.get("endDate"), scope = q.get("scope");
  if ((startDate && !endDate) || (!startDate && endDate)) return Response.json({ error: "startDate and endDate are required together" }, { status: 400, headers });

  if (startDate && endDate) {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT max(security_id) AS "securityId",ticker,market,min(date) AS "startDate",max(date) AS "endDate",count(DISTINCT date)::int AS "tradingDays",
        sum(foreign_buy) AS "foreignBuy",sum(foreign_sell) AS "foreignSell",sum(foreign_net) AS "foreignNet",
        sum(trust_buy) AS "trustBuy",sum(trust_sell) AS "trustSell",sum(trust_net) AS "trustNet",
        sum(dealer_buy) AS "dealerBuy",sum(dealer_sell) AS "dealerSell",sum(dealer_net) AS "dealerNet",
        sum(foreign_buy+trust_buy+dealer_buy) AS "totalBuy",sum(foreign_sell+trust_sell+dealer_sell) AS "totalSell",sum(total_net) AS "totalNet"
      FROM (SELECT DISTINCT ON(date,ticker,market) * FROM institutional_daily ORDER BY date,ticker,market,updated_at DESC) institutional_daily
      WHERE date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR ticker=$3) AND ($4::text IS NULL OR security_id=$4) AND ($5::text IS NULL OR lower(market)=lower($5))
      GROUP BY ticker,market ORDER BY ticker
    `, startDate, endDate, ticker, securityId, market);
    const normalized = rows.map(row => {
      const ratio = (buy: unknown, sell: unknown) => Number(buy) + Number(sell) > 0 ? Number(buy) / (Number(buy) + Number(sell)) * 100 : null;
      return { ...row, foreignPercent: ratio(row.foreignBuy, row.foreignSell), trustPercent: ratio(row.trustBuy, row.trustSell), dealerPercent: ratio(row.dealerBuy, row.dealerSell), totalPercent: ratio(row.totalBuy, row.totalSell) };
    });
    return Response.json({ data: scope === "all" || (!ticker && !securityId) ? normalized : normalized[0] ?? null, meta: { source: "production institutional_daily", currentOnly: false } }, { headers });
  }

  const limit = scope === "all" ? 50000 : 1;
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT id,date,security_id AS "securityId",ticker,market,foreign_buy AS "foreignBuy",foreign_sell AS "foreignSell",foreign_net AS "foreignNet",trust_buy AS "trustBuy",trust_sell AS "trustSell",trust_net AS "trustNet",dealer_buy AS "dealerBuy",dealer_sell AS "dealerSell",dealer_net AS "dealerNet",total_net AS "totalNet",updated_at AS "updatedAt"
    FROM (SELECT DISTINCT ON(date,ticker,market) * FROM institutional_daily ORDER BY date,ticker,market,updated_at DESC) institutional_daily WHERE ($1::text IS NULL OR ticker=$1) AND ($2::text IS NULL OR security_id=$2) AND ($3::text IS NULL OR lower(market)=lower($3)) ORDER BY date DESC LIMIT $4
  `, ticker, securityId, market, limit);
  return Response.json({ data: scope === "all" ? rows : rows[0] ?? null, meta: { source: "production institutional_daily" } }, { headers });
}

export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
