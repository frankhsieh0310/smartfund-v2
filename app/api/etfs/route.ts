import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("query")?.trim();
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") ?? "50") || 50, 1), 200);
  const where = query ? { OR: [{ code: { contains: query, mode: "insensitive" as const } }, { name: { contains: query, mode: "insensitive" as const } }] } : {};
  const [total, data] = await prisma.$transaction([prisma.etf.count({ where }), prisma.etf.findMany({ where, take: limit, orderBy: { code: "asc" } })]);
  return NextResponse.json({ data: data.map((etf) => ({ identifier: etf.code, name: etf.name, latestDate: etf.priceUpdatedAt, latestValue: etf.latestPrice ?? etf.latestNav, provider: etf.dataProvider ?? etf.provider, updatedAt: etf.updatedAt, etf })), total, limit });
}
