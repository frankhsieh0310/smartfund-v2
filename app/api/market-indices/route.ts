import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const data = await prisma.marketMaster.findMany({
    where: { assetType: "INDEX", isActive: true },
    select: { symbol: true, name: true, latestDate: true, latestClose: true, provider: true, updatedAt: true },
    orderBy: { symbol: "asc" },
  });
  return NextResponse.json({ data: data.map((row) => ({ identifier: row.symbol, name: row.name, latestDate: row.latestDate, latestClose: row.latestClose, provider: row.provider, updatedAt: row.updatedAt })), total: data.length });
}
