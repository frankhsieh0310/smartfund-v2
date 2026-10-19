import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCoreUniverseEtfIds } from "@/lib/tw-purchasable/coreUniverseFilter";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("query")?.trim();
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") ?? "50") || 50, 1), 200);
  // 2026-10-19（使用者商品範圍規則）: 只回傳「台灣買得到」的 ETF（核准母體），不顯示非核心商品。
  const coreIds = await getCoreUniverseEtfIds();
  const where = {
    id: { in: Array.from(coreIds) },
    ...(query ? { OR: [{ code: { contains: query, mode: "insensitive" as const } }, { name: { contains: query, mode: "insensitive" as const } }] } : {}),
  };
  const [total, data] = await prisma.$transaction([prisma.etf.count({ where }), prisma.etf.findMany({ where, take: limit, orderBy: { code: "asc" } })]);
  return NextResponse.json({ data: data.map((etf) => ({ identifier: etf.code, name: etf.name, latestDate: etf.priceUpdatedAt, latestValue: etf.latestPrice ?? etf.latestNav, provider: etf.dataProvider ?? etf.provider, updatedAt: etf.updatedAt, etf })), total, limit });
}
