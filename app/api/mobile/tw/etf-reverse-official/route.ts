import { prisma } from "@/lib/prisma";
import { getOfficialEtfReverse, TwOfficialError, type SqlRunner } from "@/lib/tw-official/etfReverse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: official-snapshot ETF reverse lookup for one Taiwan stock. No writes, no cron.
const okHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" };
const failHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const run: SqlRunner = (sql, values) => prisma.$queryRawUnsafe(sql, ...values);

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  try {
    const result = await getOfficialEtfReverse(run, { ticker: q.get("ticker"), page: q.get("page"), limit: q.get("limit") });
    return Response.json(result, { headers: okHeaders });
  } catch (error) {
    if (error instanceof TwOfficialError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: okHeaders });
    console.error("etf-reverse-official query failed", error instanceof Error ? error.message : error);
    return Response.json({ error: { code: "QUERY_FAILED", message: "Official snapshot query failed" } }, { status: 500, headers: failHeaders });
  }
}
