// SmartMatch 共識雷達 — incremental 1D / 7D / 30D aggregation (Phase I).
//
// Pure SQL builders + a runner that takes any `query(sql, params) -> rows` (Prisma $queryRawUnsafe
// in the cloud endpoint, node-postgres in local smoke). Recomputes the aggregate rows for
// (as-of date x window) from consensus_events + consensus_stock_links. Grade C sources never count.
// One person / one stock / one calendar day / one direction collapses to a single representative
// link before summing; each person's summed contribution is clamped to [-1, +1].

export type Window = "1D" | "7D" | "30D";
export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

const WINDOW_DAYS: Record<Window, number> = { "1D": 1, "7D": 7, "30D": 30 };

// Person-contribution CTE shared by stock + sector rollups. $1 = cutoff timestamptz.
// Grade is the BEST grade across an event's source references (A > B > C); C is dropped.
function baseCte(): string {
  return `
  with graded as (
    select e.id as event_id, e.person_id, e.event_at, e.stance,
           e.confidence, e.statement_strength, e.sector,
           (case least_grade.g when 1 then 'A' when 2 then 'B' else 'C' end) as grade
    from consensus_events e
    join lateral (
      select min(case gg when 'A' then 1 when 'B' then 2 else 3 end) as g
      from (
        select coalesce(s0.source_grade, 'C') gg from consensus_sources s0 where s0.id = e.source_id
        union all
        select coalesce(es.source_grade, s1.source_grade, 'C')
        from consensus_event_sources es left join consensus_sources s1 on s1.id = es.source_id
        where es.event_id = e.id
      ) x
    ) least_grade on true
    where e.extraction_status = 'CLASSIFIED'
      and e.event_at >= $1
      and least_grade.g <= 2            -- A or B only
  ),
  links as (
    select sl.symbol, sl.stock_id, sl.relation_type, sl.stance as link_stance,
           g.person_id, g.event_at, g.grade, g.confidence, g.statement_strength,
           row_number() over (
             partition by sl.symbol, g.person_id, date_trunc('day', g.event_at),
                          sign(case sl.stance when 'BULLISH' then 1 when 'BEARISH' then -1
                                              when 'MIXED' then 1 else 0 end)
             order by (g.statement_strength * g.confidence) desc, g.event_at desc
           ) as rn
    from consensus_stock_links sl
    join graded g on g.event_id = sl.event_id
  ),
  rep as (  -- one representative link per person/stock/day/direction
    select * from links where rn = 1
  ),
  scored as (
    select symbol, min(stock_id) as stock_id, person_id,
           max(event_at) as last_event_at,
           count(*) filter (where relation_type = 'DIRECT')   as direct_cnt,
           count(*) filter (where relation_type = 'INFERRED')  as inferred_cnt,
           -- per (person,stock) net contribution, clamped to [-1,1]
           greatest(-1, least(1, sum(
             (case link_stance when 'BULLISH' then 1 when 'BEARISH' then -1
                               when 'MIXED' then 0.25 else 0 end)
             * (case grade when 'A' then 1.0 else 0.85 end)
             * (case relation_type when 'DIRECT' then 1.0 else 0.4 end)
             * least(1.0, greatest(0.5, statement_strength))
             * least(1.0, greatest(0.5, confidence))
             * power(0.5, greatest(0, extract(epoch from ($2::timestamptz - event_at)) / 3600.0)
                         / (case $3 when '1D' then 18.0 when '7D' then 96.0 else 360.0 end))
           ))) as person_contrib
    from rep
    group by symbol, person_id
  )`;
}

export function stockAggregateSql(): string {
  return `${baseCte()}
  insert into consensus_stock_daily
    (date, "window", stock_id, symbol, company_name, bullish_people, bearish_people, neutral_people,
     direct_mentions, inferred_mentions, consensus_score, trend_score, unique_people_count, last_event_at, updated_at)
  select
    $4::date, $3,
    (select id from stocks st where st.id = agg.stock_id),
    agg.symbol,
    (select company_name from stocks st where st.id = agg.stock_id),
    count(*) filter (where person_contrib >  0.15),
    count(*) filter (where person_contrib < -0.15),
    count(*) filter (where abs(person_contrib) <= 0.15),
    sum(direct_cnt), sum(inferred_cnt),
    round(sum(person_contrib)::numeric, 4),
    round((sum(person_contrib) - coalesce((
      select prev.consensus_score from consensus_stock_daily prev
      where prev.symbol = agg.symbol and prev."window" = $3 and prev.date < $4::date
      order by prev.date desc limit 1
    ), 0))::numeric, 4),
    count(distinct person_id),
    max(last_event_at),
    now()
  from (
    select symbol, stock_id, person_id, person_contrib, direct_cnt, inferred_cnt, last_event_at
    from scored
  ) agg
  group by agg.symbol, agg.stock_id
  on conflict (date, "window", symbol) do update set
    stock_id = excluded.stock_id, company_name = excluded.company_name,
    bullish_people = excluded.bullish_people, bearish_people = excluded.bearish_people,
    neutral_people = excluded.neutral_people, direct_mentions = excluded.direct_mentions,
    inferred_mentions = excluded.inferred_mentions, consensus_score = excluded.consensus_score,
    trend_score = excluded.trend_score, unique_people_count = excluded.unique_people_count,
    last_event_at = excluded.last_event_at, updated_at = now()`;
}

export function sectorAggregateSql(): string {
  return `${baseCte()},
  sector_scored as (
    select g.sector, g.person_id,
      greatest(-1, least(1, sum(
        (case g.stance when 'BULLISH' then 1 when 'BEARISH' then -1 when 'MIXED' then 0.25 else 0 end)
        * (case g.grade when 'A' then 1.0 else 0.85 end)
        * least(1.0, greatest(0.5, g.statement_strength))
        * least(1.0, greatest(0.5, g.confidence))
        * power(0.5, greatest(0, extract(epoch from ($2::timestamptz - g.event_at))/3600.0)
                    / (case $3 when '1D' then 18.0 when '7D' then 96.0 else 360.0 end))
      ))) as person_contrib
    from graded g
    where g.sector is not null and g.sector <> ''
    group by g.sector, g.person_id
  )
  insert into consensus_sector_daily
    (date, "window", sector, bullish_people, bearish_people, neutral_people, consensus_score, trend_score, unique_people_count, updated_at)
  select $4::date, $3, s.sector,
    count(*) filter (where person_contrib >  0.15),
    count(*) filter (where person_contrib < -0.15),
    count(*) filter (where abs(person_contrib) <= 0.15),
    round(sum(person_contrib)::numeric, 4),
    round((sum(person_contrib) - coalesce((
      select prev.consensus_score from consensus_sector_daily prev
      where prev.sector = s.sector and prev."window" = $3 and prev.date < $4::date
      order by prev.date desc limit 1), 0))::numeric, 4),
    count(distinct person_id),
    now()
  from sector_scored s
  group by s.sector
  on conflict (date, "window", sector) do update set
    bullish_people = excluded.bullish_people, bearish_people = excluded.bearish_people,
    neutral_people = excluded.neutral_people, consensus_score = excluded.consensus_score,
    trend_score = excluded.trend_score, unique_people_count = excluded.unique_people_count,
    updated_at = now()`;
}

export async function aggregateConsensus(query: QueryFn, opts: { asOf?: Date } = {}): Promise<{
  asOfDate: string;
  windows: Window[];
  stockRows: number;
  sectorRows: number;
}> {
  const asOf = opts.asOf ?? new Date();
  const asOfIso = asOf.toISOString();
  const asOfDate = asOfIso.slice(0, 10);
  const windows: Window[] = ["1D", "7D", "30D"];
  let stockRows = 0;
  let sectorRows = 0;
  for (const w of windows) {
    const cutoff = new Date(asOf.getTime() - WINDOW_DAYS[w] * 86_400_000).toISOString();
    const s = (await query<{ count?: unknown }>(
      `with done as (${stockAggregateSql()} returning 1) select count(*)::int as count from done`,
      [cutoff, asOfIso, w, asOfDate],
    )) as Array<{ count: number }>;
    stockRows += Number(s[0]?.count ?? 0);
    const sc = (await query<{ count?: unknown }>(
      `with done as (${sectorAggregateSql()} returning 1) select count(*)::int as count from done`,
      [cutoff, asOfIso, w, asOfDate],
    )) as Array<{ count: number }>;
    sectorRows += Number(sc[0]?.count ?? 0);
  }
  return { asOfDate, windows, stockRows, sectorRows };
}

// Phase 9 — incremental historical rebuild. Recomputes the 1D/7D/30D aggregate rows for each
// calendar day in [fromDate, toDate] so a 180-day backfill produces a real trend history instead
// of one lump on today. Bounded by `maxDays`; never a full-table wipe (every write is an upsert).
export async function aggregateConsensusRange(
  query: QueryFn,
  opts: { fromDate: string; toDate?: string; maxDays?: number },
): Promise<{ from: string; to: string; days: number; stockRows: number; sectorRows: number }> {
  const to = opts.toDate ?? new Date().toISOString().slice(0, 10);
  const maxDays = Math.min(400, Math.max(1, opts.maxDays ?? 200));
  const start = new Date(`${opts.fromDate}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  let stockRows = 0, sectorRows = 0, days = 0;
  for (let t = start; t <= end && days < maxDays; t += 86_400_000, days++) {
    const r = await aggregateConsensus(query, { asOf: new Date(t + 23 * 3_600_000) });
    stockRows += r.stockRows;
    sectorRows += r.sectorRows;
  }
  return { from: opts.fromDate, to, days, stockRows, sectorRows };
}
