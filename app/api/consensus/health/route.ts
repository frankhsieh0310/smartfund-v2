// SmartMatch 共識雷達 — backend freshness / coverage (Phase 2, STEP 13).
// Read-only, public, CORS-open. Engineering visibility; the App does not need to render this.
//   GET /api/consensus/health

import { prisma } from "@/lib/prisma";
import { consensusFreshness, type QueryFn } from "@/lib/consensus/freshness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=60, s-maxage=120",
};
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe(sql, ...(params as unknown[])) as Promise<never[]>;

export async function GET() {
  try {
    const f = await consensusFreshness(query);
    return Response.json({ ok: true, generated_at: new Date().toISOString(), ...f }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500, headers: cors });
  }
}
