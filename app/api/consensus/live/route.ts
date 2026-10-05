// 大佬雷達 V1 — GET /api/consensus/live?type=ALL&limit=20
// Minimal read API for smartmatch-mobile. Fetches the CURRENT WallStreetCN live feed fresh on every
// call, qualifies + extracts + merges same-event items, and returns the resulting cards. No DB, no
// historical ranking, no dependency on the old consensus_events/aggregate/flip/performance pipeline.
import { buildLiveOpinionCards, filterByType } from "@/lib/consensusLive/pipeline";
import type { TopicType } from "@/lib/consensusLive/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES = new Set<TopicType | "ALL">(["ALL", "STOCK", "INDUSTRY", "COMMODITY", "MACRO", "OTHER"]);

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
    const { cards, totalFetched, qualifiedCount } = await buildLiveOpinionCards({});
    const filtered = filterByType(cards, type).slice(0, limit);
    return Response.json(
      { ok: true, type, totalFetched, qualifiedCount, mergedCardCount: cards.length, data: filtered },
      { headers: cors },
    );
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500, headers: cors });
  }
}
