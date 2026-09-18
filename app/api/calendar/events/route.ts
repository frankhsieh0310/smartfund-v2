// Read-only confirmed-event calendar for the products a user follows.
// GET ?month=YYYY-MM&items=ETF:<id>:P,FUND:<id>:W,ETF:<id>:PW
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildCalendar, parseCalendarParams } from "@/lib/calendar/eventsService";

export async function GET(request: NextRequest) {
  const parsed = parseCalendarParams(request.nextUrl.searchParams.get("month"), request.nextUrl.searchParams.get("items"));
  if ("error" in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  return NextResponse.json(await buildCalendar(prisma, parsed.month, parsed.items));
}
