import { prisma } from "@/lib/prisma";
import { getOfficialEtfHoldingsCount, TwOfficialError, type SqlRunner } from "@/lib/tw-official/etfReverse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: stock count / non-stock positions of one ETF's latest official snapshot. No writes, no cron.
const okHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" };
const failHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const run: SqlRunner = (sql, values) => prisma.$queryRawUnsafe(sql, ...values);

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  try {
    const result = await getOfficialEtfHoldingsCount(run, { code: q.get("code") });
    return Response.json(result, { headers: okHeaders });
  } catch (error) {
    if (error instanceof TwOfficialError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: okHeaders });
    console.error("etf-holdings-count query failed", error instanceof Error ? error.message : error);
    return Response.json({ error: { code: "QUERY_FAILED", message: "Official snapshot query failed" } }, { status: 500, headers: failHeaders });
  }
}
