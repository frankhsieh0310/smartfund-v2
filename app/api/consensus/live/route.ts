// 大佬雷達 V1 — GET /api/consensus/live?type=ALL&limit=20
// Read-only. Does NOT fetch WallStreetCN and does NOT call the AI Gateway — it only reads cards
// already persisted by the background cron (app/api/cron/consensus-live-ingest). Every App open is
// therefore a cheap DB read, not a repeated fetch+AI-extraction cycle.
import { prisma } from "@/lib/prisma";
import { getLiveCards } from "@/lib/consensusLive/ingest";
import type { TopicType } from "@/lib/consensusLive/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES = new Set<TopicType | "ALL">(["ALL", "STOCK", "INDUSTRY", "COMMODITY", "MACRO", "OTHER"]);
const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<never[]>;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const typeParam = (q.get("type") ?? "ALL").toUpperCase();
  const type = (VALID_TYPES.has(typeParam as TopicType | "ALL") ? typeParam : "ALL") as TopicType | "ALL";
  const limit = Math.min(50, Math.max(1, Number(q.get("limit")) || 20));

  try {
    const data = await getLiveCards(query, { type, limit });
    return Response.json({ ok: true, type, data }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500, headers: cors });
  }
}
