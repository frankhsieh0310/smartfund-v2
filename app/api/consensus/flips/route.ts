// SmartMatch 共識雷達 — viewpoint flip alerts, App-facing (Phase 6). Read-only, CORS-open.
//
//   GET /api/consensus/flips?window=1D|7D|30D&symbol=&person=&relation=DIRECT|INFERRED
//
// Backed by consensus_flip_signals (real detected flips only — no view heuristic, no fake).

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=600",
};
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);
const WIN_DAYS: Record<string, number> = { "1D": 1, "7D": 7, "30D": 30 };
const stanceZh = (s: string) => ({ BULLISH: "看多", BEARISH: "看空", NEUTRAL: "中立" } as Record<string, string>)[s] ?? s;

export async function GET(request: Request) {
  const u = new URL(request.url);
  const windowRaw = (u.searchParams.get("window") ?? "30D").toUpperCase();
  const days = WIN_DAYS[windowRaw] ?? 30;
  const symbol = u.searchParams.get("symbol");
  const person = u.searchParams.get("person");
  const relation = u.searchParams.get("relation");

  const where: string[] = [`f.current_event_at >= now() - ($1 || ' days')::interval`];
  const params: unknown[] = [String(days)];
  if (symbol) { params.push(symbol.toUpperCase()); where.push(`upper(f.symbol) = $${params.length}`); }
  if (person) { params.push(person); where.push(`p.slug = $${params.length}`); }
  if (relation === "DIRECT" || relation === "INFERRED") { params.push(relation); where.push(`f.relation_type = $${params.length}`); }

  const rows = await q<Record<string, unknown>>(
    `select f.id, p.slug as person_slug, p.display_name as person, p.category, p.organization,
            f.symbol, st.company_name, f.relation_type, f.flip_type, f.strength, f.push_eligible,
            f.previous_stance, f.current_stance, f.previous_event_at, f.current_event_at, f.gap_days,
            f.source_grade, f.notified_at,
            e.source_url, e.source_title, e.summary_zh, e.theme
       from consensus_flip_signals f
       join consensus_people p on p.id = f.person_id
       left join stocks st on st.id = f.stock_id
       join consensus_events e on e.id = f.current_event_id
      where ${where.join(" and ")}
      order by (f.strength = 'STRONG') desc, f.current_event_at desc
      limit 60`,
    ...params,
  );

  return Response.json(
    {
      ok: true,
      window: windowRaw in WIN_DAYS ? windowRaw : "30D",
      generated_at: new Date().toISOString(),
      count: rows.length,
      flips: rows.map((r) => ({
        id: String(r.id),
        person: String(r.person),
        person_slug: String(r.person_slug),
        category: (r.category as string) ?? null,
        organization: (r.organization as string) ?? null,
        symbol: String(r.symbol),
        company_name: (r.company_name as string) ?? null,
        relation_type: String(r.relation_type),
        flip_type: String(r.flip_type),
        strength: String(r.strength),
        push_eligible: Boolean(r.push_eligible),
        previous_stance: String(r.previous_stance),
        current_stance: String(r.current_stance),
        previous_stance_zh: stanceZh(String(r.previous_stance)),
        current_stance_zh: stanceZh(String(r.current_stance)),
        previous_event_at: r.previous_event_at ? new Date(r.previous_event_at as string).toISOString() : null,
        current_event_at: r.current_event_at ? new Date(r.current_event_at as string).toISOString() : null,
        gap_days: Number(r.gap_days ?? 0),
        source_grade: (r.source_grade as string) ?? null,
        source_url: String(r.source_url ?? ""),
        source_title: (r.source_title as string) ?? null,
        summary: (r.summary_zh as string) ?? (r.theme as string) ?? null,
        notified: r.notified_at != null,
      })),
    },
    { headers: cors },
  );
}
