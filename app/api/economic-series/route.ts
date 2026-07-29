import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get("provider") ?? undefined;
  const country = request.nextUrl.searchParams.get("country") ?? undefined;
  const data = await prisma.economicSeries.findMany({
    where: { ...(provider ? { provider } : {}), ...(country ? { country } : {}) },
    orderBy: [{ provider: "asc" }, { seriesId: "asc" }],
    include: { values: { orderBy: { date: "desc" }, take: 1, select: { date: true, value: true, updatedAt: true } } },
  });
  return NextResponse.json({ data: data.map(({ values, ...series }) => ({ identifier: series.seriesId, name: series.name, provider: series.provider, latestDate: values[0]?.date ?? null, latestValue: values[0]?.value ?? null, updatedAt: values[0]?.updatedAt ?? series.updatedAt, series })), total: data.length });
}
