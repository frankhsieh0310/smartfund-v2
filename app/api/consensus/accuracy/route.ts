// SmartMatch 共識雷達 — historical accuracy, App-facing (Phase 5). Read-only, CORS-open.
//
//   GET /api/consensus/accuracy               -> person leaderboard + consensus-vs-individual
//   GET /api/consensus/accuracy?person=<slug> -> one person's signal history (DIRECT + INFERRED)
//
// A hit-rate percentage is returned ONLY when matured signals >= the minimum sample for that
// horizon (1M/3M >= 5, 6M >= 3). Below that: rate = null + status "ACCUMULATING". Never fabricated.

import { prisma } from "@/lib/prisma";
import { MIN_SAMPLE } from "@/lib/consensus/performance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=1800",
};
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);
const n = (v: unknown) => (v == null ? null : Number(v));
const gate = (rate: unknown, matured: unknown, min: number) =>
  n(matured) != null && Number(matured) >= min ? n(rate) : null;

export async function GET(request: Request) {
  const person = new URL(request.url).searchParams.get("person");

  if (person) {
    const rows = await q<Record<string, unknown>>(
      `select sp.symbol, sp.relation_type, sp.stance, sp.source_grade, sp.consensus_agreement,
              sp.event_at, sp.entry_trade_date, sp.entry_price,
              sp.return_1m, sp.alpha_1m, sp.hit_1m,
              sp.return_3m, sp.alpha_3m, sp.hit_3m,
              sp.return_6m, sp.alpha_6m, sp.hit_6m,
              e.source_url, e.source_title, e.summary_zh
         from consensus_signal_performance sp
         join consensus_people p on p.id = sp.person_id
         join consensus_events e on e.id = sp.event_id
        where p.slug = $1
        order by sp.event_at desc
        limit 100`,
      person,
    );
    return Response.json(
      {
        ok: true, person,
        signals: rows.map((r) => ({
          symbol: String(r.symbol), relation_type: String(r.relation_type), stance: String(r.stance),
          source_grade: (r.source_grade as string) ?? null,
          consensus_agreement: n(r.consensus_agreement),
          event_at: r.event_at ? new Date(r.event_at as string).toISOString() : null,
          entry_trade_date: (r.entry_trade_date as string) ?? null,
          entry_price: n(r.entry_price),
          r1m: n(r.return_1m), a1m: n(r.alpha_1m), hit1m: (r.hit_1m as string) ?? null,
          r3m: n(r.return_3m), a3m: n(r.alpha_3m), hit3m: (r.hit_3m as string) ?? null,
          r6m: n(r.return_6m), a6m: n(r.alpha_6m), hit6m: (r.hit_6m as string) ?? null,
          summary_zh: (r.summary_zh as string) ?? null,
          source_title: (r.source_title as string) ?? null,
          source_url: String(r.source_url ?? ""),
        })),
      },
      { headers: cors },
    );
  }

  const people = await q<Record<string, unknown>>(
    `select slug, display_name, category, relation_type,
            signals_total, matured_1m, hit_rate_1m, avg_return_1m, avg_alpha_1m,
            matured_3m, hit_rate_3m, avg_return_3m, avg_alpha_3m,
            matured_6m, hit_rate_6m, avg_return_6m, avg_alpha_6m
       from consensus_person_accuracy
      order by relation_type, matured_3m desc nulls last, signals_total desc`,
  );

  const consensusRows = await q<Record<string, unknown>>(
    `select stance, high_consensus, signals_total,
            matured_1m, hit_rate_1m, matured_3m, hit_rate_3m, matured_6m, hit_rate_6m
       from consensus_agreement_accuracy order by stance, high_consensus desc`,
  );

  const overall = (await q<Record<string, unknown>>(
    `select count(*)::int signals_total,
            count(*) filter (where hit_1m is not null)::int matured_1m,
            count(*) filter (where hit_3m is not null)::int matured_3m,
            count(*) filter (where hit_6m is not null)::int matured_6m,
            count(*) filter (where relation_type='DIRECT')::int direct_signals,
            count(*) filter (where relation_type='INFERRED')::int inferred_signals,
            count(*) filter (where stance='BULLISH')::int bullish_signals,
            count(*) filter (where stance='BEARISH')::int bearish_signals
       from consensus_signal_performance`,
  ))[0] ?? {};

  return Response.json(
    {
      ok: true,
      generated_at: new Date().toISOString(),
      min_sample: MIN_SAMPLE,
      totals: {
        signals_total: n(overall.signals_total) ?? 0,
        matured_1m: n(overall.matured_1m) ?? 0,
        matured_3m: n(overall.matured_3m) ?? 0,
        matured_6m: n(overall.matured_6m) ?? 0,
        direct_signals: n(overall.direct_signals) ?? 0,
        inferred_signals: n(overall.inferred_signals) ?? 0,
        bullish_signals: n(overall.bullish_signals) ?? 0,
        bearish_signals: n(overall.bearish_signals) ?? 0,
      },
      // accumulating = not a single horizon has cleared the minimum sample yet
      status:
        (n(overall.matured_1m) ?? 0) >= MIN_SAMPLE["1m"] ||
        (n(overall.matured_3m) ?? 0) >= MIN_SAMPLE["3m"] ||
        (n(overall.matured_6m) ?? 0) >= MIN_SAMPLE["6m"]
          ? "READY"
          : "ACCUMULATING",
      people: people.map((r) => ({
        slug: String(r.slug), name: String(r.display_name), category: String(r.category),
        relation_type: String(r.relation_type),
        signals_total: n(r.signals_total),
        matured_1m: n(r.matured_1m), hit_rate_1m: gate(r.hit_rate_1m, r.matured_1m, MIN_SAMPLE["1m"]),
        avg_return_1m: n(r.avg_return_1m), avg_alpha_1m: n(r.avg_alpha_1m),
        matured_3m: n(r.matured_3m), hit_rate_3m: gate(r.hit_rate_3m, r.matured_3m, MIN_SAMPLE["3m"]),
        avg_return_3m: n(r.avg_return_3m), avg_alpha_3m: n(r.avg_alpha_3m),
        matured_6m: n(r.matured_6m), hit_rate_6m: gate(r.hit_rate_6m, r.matured_6m, MIN_SAMPLE["6m"]),
        avg_return_6m: n(r.avg_return_6m), avg_alpha_6m: n(r.avg_alpha_6m),
      })),
      consensus: consensusRows.map((r) => ({
        stance: String(r.stance), high_consensus: Boolean(r.high_consensus),
        signals_total: n(r.signals_total),
        matured_1m: n(r.matured_1m), hit_rate_1m: gate(r.hit_rate_1m, r.matured_1m, MIN_SAMPLE["1m"]),
        matured_3m: n(r.matured_3m), hit_rate_3m: gate(r.hit_rate_3m, r.matured_3m, MIN_SAMPLE["3m"]),
        matured_6m: n(r.matured_6m), hit_rate_6m: gate(r.hit_rate_6m, r.matured_6m, MIN_SAMPLE["6m"]),
      })),
    },
    { headers: cors },
  );
}
