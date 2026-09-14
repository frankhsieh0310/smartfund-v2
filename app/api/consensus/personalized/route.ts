// SmartMatch 共識雷達 — watchlist personalized consensus (Phase 7). Read-only, CORS-open, no AI.
//
//   GET /api/consensus/personalized?symbols=NVDA,GOOGL,TSM&window=30D
//   GET /api/consensus/personalized?userId=<uuid>&window=30D      (server-side watchlist_items)
//   GET /api/consensus/personalized?watchlist=<id>&window=30D
//
// Filters the existing consensus_stock_daily / consensus_events / consensus_flip_signals /
// consensus_person_accuracy data for the given symbol set. Never re-classifies, never writes a
// per-user table. Personalized alert eligibility is derived here (read-only; no push delivery).

import { prisma } from "@/lib/prisma";
import { buildPersonalized, normSymbols, symbolSetHash, type Win } from "@/lib/consensus/personalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);
// adapter for buildPersonalized's QueryFn shape: (sql, paramsArray)
const qf = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<never[]>;

export async function GET(request: Request) {
  const u = new URL(request.url);
  const raw = (u.searchParams.get("window") ?? "30D").toUpperCase();
  const window: Win = raw === "1D" || raw === "7D" ? (raw as Win) : "30D";
  const userId = u.searchParams.get("userId");
  const watchlistId = u.searchParams.get("watchlist");
  const symbolsParam = u.searchParams.get("symbols");

  // 1) resolve the symbol set + its provenance
  let symbols: string[] = [];
  let source = "none";
  if (symbolsParam) {
    symbols = normSymbols(symbolsParam.split(/[,\s]+/));
    source = "client-symbols";
  } else if (userId || watchlistId) {
    const rows = await q<{ display_symbol: string }>(
      `select i.display_symbol
         from watchlist_items i
         join watchlists w on w.id = i.watchlist_id
        where i.status = 'ACTIVE' and i.removed_at is null and i.asset_type = 'STOCK'
          and coalesce(w.is_test, false) = false and w.status = 'ACTIVE'
          and ${watchlistId ? "w.id = $1" : "w.owner_user_id = $1 and coalesce(w.is_default, true) = true"}
        order by i.is_pinned desc, i.sort_order nulls last, i.created_at`,
      watchlistId ?? userId,
    );
    symbols = normSymbols(rows.map((r) => r.display_symbol));
    source = watchlistId ? "watchlist-id" : "user-default-watchlist";
  }

  if (symbols.length === 0) {
    return Response.json(
      {
        ok: true, window, source, empty: true, as_of_date: null, generated_at: new Date().toISOString(),
        symbols_tracked: 0, symbols_with_consensus: 0, symbols_with_flips: 0, symbols_with_no_view: 0,
        symbols_warming: 0, symbols_cooling: 0,
        buckets: {}, rows: [], reverse_match_seed: [], alert_eligible: [],
        cache_key: symbolSetHash([], window),
      },
      { headers: { ...cors, "Cache-Control": "public, max-age=300, s-maxage=600" } },
    );
  }

  const { rows, asOfDate } = await buildPersonalized(qf as never, { symbols, window });

  const bucketCounts: Record<string, number> = {};
  for (const r of rows) for (const b of r.buckets) bucketCounts[b] = (bucketCounts[b] ?? 0) + 1;

  const withConsensus = rows.filter((r) => r.has_view).length;
  const withFlips = rows.filter((r) => r.latest_flip).length;
  const noView = rows.filter((r) => !r.has_view).length;

  // personalized alert eligibility: symbol in this watchlist AND a push-eligible flip (STRONG preferred)
  const alertEligible = rows
    .filter((r) => r.latest_flip?.push_eligible)
    .map((r) => ({
      symbol: r.symbol, person: r.latest_flip!.person, flip_type: r.latest_flip!.flip_type,
      strength: r.latest_flip!.strength, current_event_at: r.latest_flip!.current_event_at,
      priority: r.latest_flip!.strength === "STRONG" ? "HIGH" : "NORMAL",
    }));

  const reverseSeed = rows
    .filter((r) => r.has_view)
    .map((r) => ({ ticker: r.symbol, name: r.company_name || r.symbol, market: "US" }));

  return Response.json(
    {
      ok: true,
      window,
      source,
      empty: false,
      as_of_date: asOfDate,
      generated_at: new Date().toISOString(),
      cache_key: symbolSetHash(symbols, window),
      symbols_tracked: rows.length,
      symbols_with_consensus: withConsensus,
      symbols_with_flips: withFlips,
      symbols_with_no_view: noView,
      symbols_warming: bucketCounts["WATCHLIST_WARMING"] ?? 0,
      symbols_cooling: bucketCounts["WATCHLIST_COOLING"] ?? 0,
      buckets: bucketCounts,
      rows,
      alert_eligible: alertEligible,
      reverse_match_seed: reverseSeed,
    },
    { headers: { ...cors, "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=1800" } },
  );
}
