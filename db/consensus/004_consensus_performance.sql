-- 共識雷達 Phase 5 — historical accuracy (1M / 3M / 6M). Additive, reversible. No AI.
-- Signal = one CLASSIFIED consensus_stock_link with stance in ('BULLISH','BEARISH').
-- Entry = first trading day STRICTLY AFTER event_at's date (conservative, no look-ahead).
-- Forward = first trading day >= (entry_date + 1/3/6 months). Immature horizon -> NULL (not zero).

create table if not exists consensus_signal_performance (
  id                text primary key default gen_random_uuid()::text,
  stock_link_id     text not null references consensus_stock_links(id) on delete cascade,
  event_id          text not null references consensus_events(id) on delete cascade,
  person_id         text not null references consensus_people(id) on delete cascade,
  stock_id          text references stocks(id) on delete set null,
  symbol            text not null,
  relation_type     text not null check (relation_type in ('DIRECT','INFERRED')),
  stance            text not null check (stance in ('BULLISH','BEARISH')),
  source_grade      text,
  consensus_agreement integer not null default 1,   -- distinct people, same direction, same symbol, +/-3d of event

  event_at          timestamptz not null,
  entry_trade_date  date,
  entry_price       numeric,
  benchmark_symbol  text,

  price_1m_date date, price_1m numeric, return_1m numeric, benchmark_return_1m numeric, alpha_1m numeric,
  hit_1m text check (hit_1m in ('HIT','MISS','FLAT')),
  price_3m_date date, price_3m numeric, return_3m numeric, benchmark_return_3m numeric, alpha_3m numeric,
  hit_3m text check (hit_3m in ('HIT','MISS','FLAT')),
  price_6m_date date, price_6m numeric, return_6m numeric, benchmark_return_6m numeric, alpha_6m numeric,
  hit_6m text check (hit_6m in ('HIT','MISS','FLAT')),

  computed_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (stock_link_id)
);
create index if not exists csp_person_idx on consensus_signal_performance(person_id, relation_type);
create index if not exists csp_symbol_idx on consensus_signal_performance(symbol);
create index if not exists csp_immature_idx on consensus_signal_performance(event_at)
  where hit_1m is null or hit_3m is null or hit_6m is null;

-- country / exchange -> benchmark index code (index_history via market_indexes.code).
create table if not exists consensus_benchmark_map (
  key           text primary key,          -- exchange code OR country code
  benchmark_code     text not null,        -- primary market_indexes.code
  fallback_code text,                      -- used when primary lacks the date
  label         text
);
insert into consensus_benchmark_map (key, benchmark_code, fallback_code, label) values
  ('US','^GSPC','^IXIC','S&P 500'),
  ('NASDAQ','^GSPC','^IXIC','S&P 500'),
  ('NYSE','^GSPC','^IXIC','S&P 500'),
  ('TW','^TWII',null,'TAIEX'),
  ('TWSE','^TWII',null,'TAIEX'),
  ('JP','^N225',null,'Nikkei 225'),
  ('JPX','^N225',null,'Nikkei 225'),
  ('KR','^KS11',null,'KOSPI'),
  ('KRX','^KS11',null,'KOSPI'),
  ('HK','^HSI',null,'Hang Seng'),
  ('HKG','^HSI',null,'Hang Seng'),
  ('CN','000001.SS','000300.SS','SSE Composite'),
  ('SSE','000001.SS','000300.SS','SSE Composite'),
  ('EU','^STOXX50E','^GDAXI','EURO STOXX 50'),
  ('DE','^GDAXI',null,'DAX'),
  ('FR','^FCHI',null,'CAC 40'),
  ('GB','^FTSE',null,'FTSE 100')
on conflict (key) do nothing;

-- person accuracy (bull/bear only; neutral/unclear never enter; DIRECT vs INFERRED kept separate).
create or replace view consensus_person_accuracy as
select
  p.id as person_id, p.slug, p.display_name, p.category, sp.relation_type,
  count(*)::int as signals_total,
  count(*) filter (where sp.hit_1m is not null)::int as matured_1m,
  round(avg((sp.hit_1m = 'HIT')::int) filter (where sp.hit_1m in ('HIT','MISS')) * 100, 1) as hit_rate_1m,
  round(avg(sp.return_1m) filter (where sp.return_1m is not null) * 100, 2) as avg_return_1m,
  round(avg(sp.alpha_1m)  filter (where sp.alpha_1m  is not null) * 100, 2) as avg_alpha_1m,
  count(*) filter (where sp.hit_3m is not null)::int as matured_3m,
  round(avg((sp.hit_3m = 'HIT')::int) filter (where sp.hit_3m in ('HIT','MISS')) * 100, 1) as hit_rate_3m,
  round(avg(sp.return_3m) filter (where sp.return_3m is not null) * 100, 2) as avg_return_3m,
  round(avg(sp.alpha_3m)  filter (where sp.alpha_3m  is not null) * 100, 2) as avg_alpha_3m,
  count(*) filter (where sp.hit_6m is not null)::int as matured_6m,
  round(avg((sp.hit_6m = 'HIT')::int) filter (where sp.hit_6m in ('HIT','MISS')) * 100, 1) as hit_rate_6m,
  round(avg(sp.return_6m) filter (where sp.return_6m is not null) * 100, 2) as avg_return_6m,
  round(avg(sp.alpha_6m)  filter (where sp.alpha_6m  is not null) * 100, 2) as avg_alpha_6m
from consensus_signal_performance sp
join consensus_people p on p.id = sp.person_id
group by p.id, p.slug, p.display_name, p.category, sp.relation_type;

-- consensus accuracy: signals where >= 2 distinct people agreed on the symbol/direction near the event.
create or replace view consensus_agreement_accuracy as
select
  sp.stance,
  (sp.consensus_agreement >= 2) as high_consensus,
  count(*)::int as signals_total,
  count(*) filter (where sp.hit_1m is not null)::int as matured_1m,
  round(avg((sp.hit_1m = 'HIT')::int) filter (where sp.hit_1m in ('HIT','MISS')) * 100, 1) as hit_rate_1m,
  count(*) filter (where sp.hit_3m is not null)::int as matured_3m,
  round(avg((sp.hit_3m = 'HIT')::int) filter (where sp.hit_3m in ('HIT','MISS')) * 100, 1) as hit_rate_3m,
  count(*) filter (where sp.hit_6m is not null)::int as matured_6m,
  round(avg((sp.hit_6m = 'HIT')::int) filter (where sp.hit_6m in ('HIT','MISS')) * 100, 1) as hit_rate_6m
from consensus_signal_performance sp
where sp.relation_type = 'DIRECT'
group by sp.stance, (sp.consensus_agreement >= 2);

-- rollback:
--   drop view if exists consensus_agreement_accuracy;
--   drop view if exists consensus_person_accuracy;
--   drop table if exists consensus_benchmark_map;
--   drop table if exists consensus_signal_performance;
