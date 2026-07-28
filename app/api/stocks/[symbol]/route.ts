import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalForPrisma = globalThis as unknown as { stockApiPrisma?: PrismaClient };
const prisma = globalForPrisma.stockApiPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.stockApiPrisma = prisma;

export async function GET(_request: Request, context: RouteContext<"/api/stocks/[symbol]">) {
  const { symbol } = await context.params;
  const stock = await prisma.stock.findUnique({
    where: { yahooSymbol: decodeURIComponent(symbol) },
    select: {
      ticker: true,
      yahooSymbol: true,
      exchange: true,
      companyName: true,
      currency: true,
      latestDate: true,
      latestClose: true,
      history: { orderBy: { date: "desc" }, take: 1, select: { date: true, open: true, high: true, low: true, close: true, adjustedClose: true, volume: true, source: true, sourceSymbol: true } },
    },
  });
  if (!stock) return NextResponse.json({ error: "STOCK_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ ...stock, latest: stock.history[0] ?? null }, { headers: { "Cache-Control": "no-store" } });
}
