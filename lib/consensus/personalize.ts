// SmartMatch 共識雷達 — watchlist personalized consensus (Phase 7). No AI. Filters existing
// consensus data for a set of symbols; never re-classifies, never materialises per-user tables.

import { MIN_SAMPLE } from "./performance";

export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;
export type Win = "1D" | "7D" | "30D";

export const normSymbols = (raw: string[]): string[] =>
  [...new Set(raw.map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9.]/g, "")).filter(Boolean))].slice(0, 100);

export function symbolSetHash(symbols: string[], window: string): string {
  const key = [...symbols].sort().join(",") + "|" + window;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export type PersonalRow = {
  symbol: string;
  company_name: string | null;
  stock_id: string | null;
  consensus_score: number;
  trend_score: number;
  bullish_people: number;
  bearish_people: number;
  neutral_people: number;
  direct_mentions: number;
  inferred_mentions: number;
  unique_people_count: number;
  latest_event_at: string | null;
  latest_event: {
    person: string; stance: string; summary_zh: string | null; relation_type: string | null;
    event_at: string | null; source_title: string | null; source_url: string;
    person_hit_rate_1m: number | null; person_hit_rate_matured_1m: number | null;
  } | null;
  latest_flip: {
    person: string; flip_type: string; strength: string; relation_type: string;
    previous_stance: string; current_stance: string; current_event_at: string | null; push_eligible: boolean;
  } | null;
  buckets: string[];
  personal_priority_score: number;
  has_view: boolean;
};

// deterministic — decides what the user should look at first, NOT investment advice.
export function personalPriorityScore(input: {
  consensusScore: number; trendScore: number; directMentions: number;
  flipType: string | null; latestEventAtMs: number | null; now: number;
}): number {
  const conviction = Math.min(1.5, Math.abs(input.consensusScore));
  const trend = Math.min(0.6, Math.abs(input.trendScore));
  const flipBonus = input.flipType
    ? (input.flipType === "BEAR_TO_BULL" || input.flipType === "BULL_TO_BEAR" ? 0.6
      : input.flipType === "NEUTRAL_TO_BULL" || input.flipType === "NEUTRAL_TO_BEAR" ? 0.4 : 0.2)
    : 0;
  const directBonus = input.directMentions > 0 ? 0.2 : 0;
  const ageDays = input.latestEventAtMs ? (input.now - input.latestEventAtMs) / 86_400_000 : Infinity;
  const freshness = ageDays <= 3 ? 0.3 : ageDays <= 14 ? 0.15 : 0;
  return Math.round((conviction + trend + flipBonus + directBonus + freshness) * 10000) / 10000;
}

function bucketsFor(r: {
  consensus_score: number; trend_score: number; direct_mentions: number;
  bullish_people: number; bearish_people: number; hasFlip: boolean; hasView: boolean;
}): string[] {
  if (!r.hasView) return ["WATCHLIST_NO_VIEW"];
  const b: string[] = [];
  if (r.consensus_score >= 0.35 || (r.bullish_people >= 2 && r.consensus_score > 0.1)) b.push("WATCHLIST_STRONG_BULLISH");
  if (r.consensus_score <= -0.35 || (r.bearish_people >= 2 && r.consensus_score < -0.1)) b.push("WATCHLIST_STRONG_BEARISH");
  if (r.trend_score > 0.05) b.push("WATCHLIST_WARMING");
  if (r.trend_score < -0.05) b.push("WATCHLIST_COOLING");
  if (r.hasFlip) b.push("WATCHLIST_FLIP");
  return b.length ? b : ["WATCHLIST_HAS_VIEW"];
}

export async function buildPersonalized(
  query: QueryFn,
  opts: { symbols: string[]; window: Win },
): Promise<{ rows: PersonalRow[]; asOfDate: string | null }> {
  const symbols = normSymbols(opts.symbols);
  if (symbols.length === 0) return { rows: [], asOfDate: null };
  const now = Date.now();

  const latestDate = (await query<{ d: string | null }>(
    `select max(date)::text d from consensus_stock_daily where "window" = $1`, [opts.window],
  ))[0]?.d ?? null;

  const daily = latestDate
    ? ((await query<Record<string, unknown>>(
        `select symbol, company_name, stock_id, bullish_people, bearish_people, neutral_people,
                direct_mentions, inferred_mentions, consensus_score, trend_score, unique_people_count, last_event_at
           from consensus_stock_daily
          where "window" = $1 and date = $2::date and symbol = any($3)`,
        [opts.window, latestDate, symbols],
      )) as Array<Record<string, unknown>>)
    : [];
  const dailyBySym = new Map(daily.map((d) => [String(d.symbol), d]));

  // latest classified event per symbol (any relation), with the person's DIRECT 1M hit-rate if mature
  const latestEvents = (await query<Record<string, unknown>>(
    `select distinct on (sl.symbol)
            sl.symbol, p.display_name as person, e.stance, e.summary_zh, sl.relation_type,
            e.event_at, e.source_title, e.source_url,
            pa.hit_rate_1m as person_hit_rate_1m, pa.matured_1m as person_matured_1m
       from consensus_stock_links sl
       join consensus_events e on e.id = sl.event_id and e.extraction_status = 'CLASSIFIED'
       join consensus_people p on p.id = e.person_id
  left join consensus_person_accuracy pa on pa.person_id = e.person_id and pa.relation_type = 'DIRECT'
      where sl.symbol = any($1)
      order by sl.symbol, e.event_at desc`,
    [symbols],
  )) as Array<Record<string, unknown>>;
  const evBySym = new Map(latestEvents.map((e) => [String(e.symbol), e]));

  // latest flip per symbol inside the window
  const days = opts.window === "1D" ? 1 : opts.window === "7D" ? 7 : 30;
  const flips = (await query<Record<string, unknown>>(
    `select distinct on (f.symbol)
            f.symbol, p.display_name as person, f.flip_type, f.strength, f.relation_type,
            f.previous_stance, f.current_stance, f.current_event_at, f.push_eligible
       from consensus_flip_signals f
       join consensus_people p on p.id = f.person_id
      where f.symbol = any($1) and f.current_event_at >= now() - ($2 || ' days')::interval
      order by f.symbol, f.current_event_at desc`,
    [symbols, String(days)],
  )) as Array<Record<string, unknown>>;
  const flipBySym = new Map(flips.map((f) => [String(f.symbol), f]));

  const n = (v: unknown) => (v == null ? 0 : Number(v));
  const rows: PersonalRow[] = symbols.map((sym) => {
    const d = dailyBySym.get(sym);
    const ev = evBySym.get(sym);
    const fl = flipBySym.get(sym);
    const hasView = Boolean(d || ev);
    const consensus_score = n(d?.consensus_score);
    const trend_score = n(d?.trend_score);
    const direct_mentions = n(d?.direct_mentions) || (ev && ev.relation_type === "DIRECT" ? 1 : 0);
    const latestEventAt = (d?.last_event_at as string) ?? (ev?.event_at as string) ?? null;
    const matured1m = ev ? n(ev.person_matured_1m) : 0;
    const rate1m = ev && matured1m >= MIN_SAMPLE["1m"] ? n(ev.person_hit_rate_1m) : null;

    return {
      symbol: sym,
      company_name: (d?.company_name as string) ?? null,
      stock_id: (d?.stock_id as string) ?? null,
      consensus_score, trend_score,
      bullish_people: n(d?.bullish_people),
      bearish_people: n(d?.bearish_people),
      neutral_people: n(d?.neutral_people),
      direct_mentions,
      inferred_mentions: n(d?.inferred_mentions),
      unique_people_count: n(d?.unique_people_count),
      latest_event_at: latestEventAt ? new Date(latestEventAt).toISOString() : null,
      latest_event: ev
        ? {
            person: String(ev.person), stance: String(ev.stance),
            summary_zh: (ev.summary_zh as string) ?? null,
            relation_type: (ev.relation_type as string) ?? null,
            event_at: ev.event_at ? new Date(ev.event_at as string).toISOString() : null,
            source_title: (ev.source_title as string) ?? null,
            source_url: String(ev.source_url ?? ""),
            person_hit_rate_1m: rate1m,
            person_hit_rate_matured_1m: matured1m,
          }
        : null,
      latest_flip: fl
        ? {
            person: String(fl.person), flip_type: String(fl.flip_type), strength: String(fl.strength),
            relation_type: String(fl.relation_type),
            previous_stance: String(fl.previous_stance), current_stance: String(fl.current_stance),
            current_event_at: fl.current_event_at ? new Date(fl.current_event_at as string).toISOString() : null,
            push_eligible: Boolean(fl.push_eligible),
          }
        : null,
      buckets: bucketsFor({
        consensus_score, trend_score, direct_mentions,
        bullish_people: n(d?.bullish_people), bearish_people: n(d?.bearish_people),
        hasFlip: Boolean(fl), hasView,
      }),
      personal_priority_score: personalPriorityScore({
        consensusScore: consensus_score, trendScore: trend_score, directMentions: direct_mentions,
        flipType: fl ? String(fl.flip_type) : null,
        latestEventAtMs: latestEventAt ? Date.parse(latestEventAt) : null, now,
      }),
      has_view: hasView,
    };
  });

  rows.sort((a, b) => b.personal_priority_score - a.personal_priority_score || a.symbol.localeCompare(b.symbol));
  return { rows, asOfDate: latestDate };
}
