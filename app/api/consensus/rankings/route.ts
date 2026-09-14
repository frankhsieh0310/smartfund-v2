// SmartMatch 共識雷達 — App-facing read API (Phase L).
//
//   GET /api/consensus/rankings?window=1D|7D|30D
//
// Serves the pre-aggregated consensus_stock_daily / consensus_sector_daily rows for the latest
// available date, plus recent viewpoint flips and latest raw events. Read-only, CORS-open, cached
// briefly. `empty: true` when there is not yet enough real data (App shows the empty state; it must
// NEVER fall back to mock rankings).

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=600",
};
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

type Win = "1D" | "7D" | "30D";
const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);
const n = (v: unknown) => (v == null ? 0 : Number(v));

export async function GET(request: Request) {
  const raw = (new URL(request.url).searchParams.get("window") ?? "7D").toUpperCase();
  const window: Win = raw === "1D" || raw === "30D" ? (raw as Win) : "7D";

  const latest = (await q<{ d: string | null }>(
    `select max(date)::text d from consensus_stock_daily where "window" = $1`, window,
  ))[0]?.d ?? null;

  // freshness metadata — App shows real 更新時間 (never fakes "today"); ai/backlog fields let the
  // App render a "資料處理中" state instead of an empty one when source data is landing but the
  // classifier is temporarily unavailable.
  const fresh = (await q<{ latest_event: string | null; people: number; sources: number; needs_review: number; newest_raw: string | null }>(
    `select
       max(e.event_at) filter (where e.extraction_status = 'CLASSIFIED') as latest_event,
       count(distinct e.person_id) filter (where e.extraction_status = 'CLASSIFIED')::int as people,
       count(distinct e.source_id)  filter (where e.extraction_status = 'CLASSIFIED')::int as sources,
       count(*) filter (where e.extraction_status = 'NEEDS_REVIEW')::int as needs_review,
       max(coalesce(e.published_at, e.event_at)) filter (where e.extraction_status = 'NEEDS_REVIEW') as newest_raw
     from consensus_events e`,
  ))[0] ?? { latest_event: null, people: 0, sources: 0, needs_review: 0, newest_raw: null };
  const aiRow = (await q<{ value: { status?: string } }>(`select value from consensus_meta where key = 'ai_health'`))[0];
  const meta = {
    latest_source_event_at: fresh.latest_event ? new Date(fresh.latest_event).toISOString() : null,
    coverage_people: n(fresh.people),
    coverage_sources: n(fresh.sources),
    ai_gateway_status: aiRow?.value?.status ?? "UNKNOWN",
    pending_review_count: n(fresh.needs_review),
    newest_unprocessed_at: fresh.newest_raw ? new Date(fresh.newest_raw).toISOString() : null,
  };

  // latest events + flips are NOT window-scoped: they surface the newest real viewpoints even before
  // a window has enough data to rank. (The App's 大佬最新觀點 section always has something to show.)
  const flipsRaw = await q<Record<string, unknown>>(
    `select f.symbol, f.display_name as person, f.category, f.prev_stance, f.current_stance,
            f.prev_event_at, f.current_event_at
       from consensus_viewpoint_flips f
      where f.current_event_at >= now() - interval '45 days'
      order by f.current_event_at desc limit 20`,
  );
  const latestEventsRaw = await q<Record<string, unknown>>(
    `select e.id, p.display_name as person, p.category, p.organization,
            e.stance, e.summary_zh, e.sector, e.theme, e.event_at, e.source_url, e.source_title,
            e.direct_stock_symbols, e.inferred_stock_symbols, e.extraction_status
       from consensus_events e
       join consensus_people p on p.id = e.person_id
      where e.extraction_status = 'CLASSIFIED'
      order by e.event_at desc limit 15`,
  );
  const flips = flipsRaw.map((f) => ({
    symbol: String(f.symbol), person: String(f.person), category: (f.category as string) ?? null,
    from: String(f.prev_stance), to: String(f.current_stance),
    prev_event_at: f.prev_event_at ? new Date(f.prev_event_at as string).toISOString() : null,
    current_event_at: f.current_event_at ? new Date(f.current_event_at as string).toISOString() : null,
  }));
  const latest_events = latestEventsRaw.map((e) => ({
    id: String(e.id), person: String(e.person), category: (e.category as string) ?? null,
    organization: (e.organization as string) ?? null, stance: String(e.stance),
    summary_zh: (e.summary_zh as string) ?? null, sector: (e.sector as string) ?? null, theme: (e.theme as string) ?? null,
    event_at: e.event_at ? new Date(e.event_at as string).toISOString() : null,
    source_url: String(e.source_url), source_title: (e.source_title as string) ?? null,
    direct_symbols: Array.isArray(e.direct_stock_symbols) ? e.direct_stock_symbols : [],
    inferred_symbols: Array.isArray(e.inferred_stock_symbols) ? e.inferred_stock_symbols : [],
  }));

  if (!latest) {
    return Response.json(
      { ok: true, window, as_of_date: null, empty: true, generated_at: new Date().toISOString(), ...meta,
        counts: { stocks: 0, flips: flips.length, latest_events: latest_events.length },
        bullish: [], bearish: [], warming: [], cooling: [], flips, latest_events, sectors: [] },
      { headers: cors },
    );
  }

  const rows = await q<Record<string, unknown>>(
    `select symbol, company_name, stock_id,
            bullish_people, bearish_people, neutral_people,
            direct_mentions, inferred_mentions,
            consensus_score, trend_score, unique_people_count, last_event_at
       from consensus_stock_daily
      where "window" = $1 and date = $2::date`,
    window, latest,
  );

  const shape = (r: Record<string, unknown>) => ({
    symbol: String(r.symbol),
    company_name: (r.company_name as string) ?? null,
    stock_id: (r.stock_id as string) ?? null,
    bullish_people: n(r.bullish_people),
    bearish_people: n(r.bearish_people),
    neutral_people: n(r.neutral_people),
    direct_mentions: n(r.direct_mentions),
    inferred_mentions: n(r.inferred_mentions),
    consensus_score: n(r.consensus_score),
    trend_score: n(r.trend_score),
    unique_people_count: n(r.unique_people_count),
    last_event_at: r.last_event_at ? new Date(r.last_event_at as string).toISOString() : null,
  });
  const all = rows.map(shape);

  const bullish = [...all].filter((r) => r.consensus_score > 0).sort((a, b) => b.consensus_score - a.consensus_score).slice(0, 25);
  const bearish = [...all].filter((r) => r.consensus_score < 0).sort((a, b) => a.consensus_score - b.consensus_score).slice(0, 25);
  const warming = [...all].filter((r) => r.trend_score > 0.05).sort((a, b) => b.trend_score - a.trend_score).slice(0, 25);
  const cooling = [...all].filter((r) => r.trend_score < -0.05).sort((a, b) => a.trend_score - b.trend_score).slice(0, 25);

  const sectors = await q<Record<string, unknown>>(
    `select sector, bullish_people, bearish_people, neutral_people, consensus_score, trend_score, unique_people_count
       from consensus_sector_daily where "window" = $1 and date = $2::date
      order by consensus_score desc`,
    window, latest,
  );

  return Response.json(
    {
      ok: true,
      window,
      as_of_date: latest,
      generated_at: new Date().toISOString(),
      ...meta,
      empty: all.length === 0,
      counts: { stocks: all.length, flips: flips.length, latest_events: latest_events.length },
      bullish,
      bearish,
      warming,
      cooling,
      flips,
      latest_events,
      sectors: sectors.map((s) => ({
        sector: String(s.sector),
        bullish_people: n(s.bullish_people),
        bearish_people: n(s.bearish_people),
        neutral_people: n(s.neutral_people),
        consensus_score: n(s.consensus_score),
        trend_score: n(s.trend_score),
        unique_people_count: n(s.unique_people_count),
      })),
    },
    { headers: cors },
  );
}
