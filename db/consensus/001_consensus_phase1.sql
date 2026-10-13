-- SmartMatch 大佬觀點・共識雷達 — Real Data Phase 1 (additive, reversible)
-- Product chain: people -> whitelisted sources -> raw viewpoint events -> stance ->
--   sector/theme -> DIRECT stocks -> INFERRED related stocks -> 1D/7D/30D consensus.
-- Rules: NO SOURCE = NO VIEWPOINT; NO_VIEW != NEUTRAL; DIRECT != INFERRED;
--   one original talk re-syndicated by many outlets = ONE event (many source refs).

create extension if not exists pgcrypto;

-- 1. people whitelist ---------------------------------------------------------
create table if not exists consensus_people (
  id             text primary key default gen_random_uuid()::text,
  slug           text not null unique,
  display_name   text not null,
  name_en        text,
  category       text not null check (category in ('POLICY','TECH','FINANCE','ENERGY','INDUSTRY','INVESTOR')),
  organization   text,
  role           text,
  country        text,
  aliases        jsonb not null default '[]'::jsonb,
  source_priorities jsonb not null default '[]'::jsonb,
  priority       integer not null default 100,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 2. source registry (whitelist only) --------------------------------------------
create table if not exists consensus_sources (
  id             text primary key default gen_random_uuid()::text,
  slug           text not null unique,
  source_type    text not null,
  source_name    text not null,
  source_grade   text not null check (source_grade in ('A','B','C')),
  canonical_url  text,
  person_id      text references consensus_people(id) on delete set null,
  is_official    boolean not null default false,
  fetch_method   text not null default 'MANUAL',
  refresh_interval_minutes integer not null default 180,
  last_checkpoint jsonb,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

-- 3. raw viewpoint events (one per original statement) --------------------------
create table if not exists consensus_events (
  id                   text primary key default gen_random_uuid()::text,
  person_id            text not null references consensus_people(id) on delete cascade,
  source_id            text references consensus_sources(id) on delete set null,
  canonical_event_key  text not null unique,
  event_at             timestamptz not null,
  published_at         timestamptz,
  event_type           text,
  source_url           text not null,
  source_title         text,
  original_text        text,
  summary_zh           text,
  language             text default 'en',
  stance               text not null check (stance in ('BULLISH','BEARISH','NEUTRAL','MIXED','UNCLEAR')),
  confidence           numeric not null default 0.6 check (confidence >= 0 and confidence <= 1),
  statement_strength   numeric not null default 0.6 check (statement_strength >= 0 and statement_strength <= 1),
  sector               text,
  theme                text,
  direct_stock_symbols   jsonb not null default '[]'::jsonb,
  inferred_stock_symbols jsonb not null default '[]'::jsonb,
  extraction_status    text not null default 'CLASSIFIED' check (extraction_status in ('CLASSIFIED','NEEDS_REVIEW','REJECTED')),
  extraction_model     text,
  location             text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists consensus_events_person_idx on consensus_events(person_id, event_at desc);
create index if not exists consensus_events_recent_idx on consensus_events(event_at desc);

-- one original talk, many outlet URLs -----------------------------------------
create table if not exists consensus_event_sources (
  id           text primary key default gen_random_uuid()::text,
  event_id     text not null references consensus_events(id) on delete cascade,
  source_id    text references consensus_sources(id) on delete set null,
  url          text not null,
  source_grade text,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (event_id, url)
);

-- 5 (schema no.4). per-event stock links (DIRECT vs INFERRED) --------------
create table if not exists consensus_stock_links (
  id            text primary key default gen_random_uuid()::text,
  event_id      text not null references consensus_events(id) on delete cascade,
  stock_id      text references stocks(id) on delete set null,
  symbol        text not null,
  exchange      text,
  relation_type text not null check (relation_type in ('DIRECT','INFERRED')),
  stance        text not null check (stance in ('BULLISH','BEARISH','NEUTRAL','MIXED','UNCLEAR')),
  confidence    numeric not null default 0.6,
  reason        text,
  created_at    timestamptz not null default now(),
  unique (event_id, symbol, relation_type)
);
create index if not exists consensus_stock_links_symbol_idx on consensus_stock_links(symbol);
create index if not exists consensus_stock_links_stock_idx on consensus_stock_links(stock_id);

-- 5. daily aggregate per stock per window -----------------------------------
create table if not exists consensus_stock_daily (
  id                 text primary key default gen_random_uuid()::text,
  date               date not null,
  "window"           text not null check ("window" in ('1D','7D','30D')),
  stock_id           text references stocks(id) on delete set null,
  symbol             text not null,
  company_name       text,
  bullish_people     integer not null default 0,
  bearish_people     integer not null default 0,
  neutral_people     integer not null default 0,
  direct_mentions    integer not null default 0,
  inferred_mentions  integer not null default 0,
  consensus_score    numeric not null default 0,
  trend_score        numeric not null default 0,
  unique_people_count integer not null default 0,
  last_event_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (date, "window", symbol)
);

-- 6. daily aggregate per sector per window ---------------------------------
create table if not exists consensus_sector_daily (
  id                 text primary key default gen_random_uuid()::text,
  date               date not null,
  "window"           text not null check ("window" in ('1D','7D','30D')),
  sector             text not null,
  bullish_people     integer not null default 0,
  bearish_people     integer not null default 0,
  neutral_people     integer not null default 0,
  consensus_score    numeric not null default 0,
  trend_score        numeric not null default 0,
  unique_people_count integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (date, "window", sector)
);

-- Phase J: viewpoint flips as a live query (no table needed for v1) ----------
create or replace view consensus_viewpoint_flips as
with ordered as (
  select
    e.person_id,
    sl.symbol,
    sl.relation_type,
    e.id as current_event_id,
    e.event_at as current_event_at,
    e.stance as current_stance,
    lag(e.stance)   over (partition by e.person_id, sl.symbol order by e.event_at) as prev_stance,
    lag(e.event_at) over (partition by e.person_id, sl.symbol order by e.event_at) as prev_event_at
  from consensus_events e
  join consensus_stock_links sl on sl.event_id = e.id
  where e.extraction_status = 'CLASSIFIED'
)
select o.*, p.display_name, p.category
from ordered o
join consensus_people p on p.id = o.person_id
where o.prev_stance is not null
  and o.prev_stance <> o.current_stance
  and o.current_stance in ('BULLISH','BEARISH')
  and o.prev_stance in ('BULLISH','BEARISH','NEUTRAL');

-- RLS: public read of consensus data; writes are owner-only (cron). ---------
alter table consensus_people        enable row level security;
alter table consensus_sources       enable row level security;
alter table consensus_events        enable row level security;
alter table consensus_event_sources enable row level security;
alter table consensus_stock_links   enable row level security;
alter table consensus_stock_daily   enable row level security;
alter table consensus_sector_daily  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['consensus_people','consensus_sources','consensus_events','consensus_event_sources','consensus_stock_links','consensus_stock_daily','consensus_sector_daily']
  loop
    execute format('drop policy if exists %I_read on %I', t || '_read', t);
    execute format('create policy %I on %I for select to anon, authenticated using (true)', t || '_read', t);
  end loop;
end $$;
