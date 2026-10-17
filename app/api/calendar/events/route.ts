// Read-only confirmed-event calendar for the products a user follows.
// GET ?month=YYYY-MM&items=ETF:<id>:P,FUND:<id>:W,ETF:<id>:PW
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildCalendar, parseCalendarParams } from "@/lib/calendar/eventsService";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
}

export async function GET(request: NextRequest) {
  const parsed = parseCalendarParams(request.nextUrl.searchParams.get("month"), request.nextUrl.searchParams.get("items"));
  if ("error" in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400, headers });
  return NextResponse.json(await buildCalendar(prisma, parsed.month, parsed.items), { headers });
}
