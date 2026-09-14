-- 共識雷達 Phase 6 — viewpoint flip alerts. Additive, reversible. No AI (DB incremental compare only).
-- A flip = same person + same symbol + same relation_type, an EARLIER classified stance changing to a
-- DIFFERENT valid current stance within MAX_FLIP_GAP_DAYS. NO_VIEW / UNCLEAR never count; media
-- re-syndication of one statement is already one event (canonical_event_key), so it cannot re-alert.

create table if not exists consensus_flip_signals (
  id                 text primary key default gen_random_uuid()::text,
  person_id          text not null references consensus_people(id) on delete cascade,
  stock_id           text references stocks(id) on delete set null,
  symbol             text not null,
  relation_type      text not null check (relation_type in ('DIRECT','INFERRED')),
  previous_event_id  text not null references consensus_events(id) on delete cascade,
  current_event_id   text not null references consensus_events(id) on delete cascade,
  previous_stance    text not null check (previous_stance in ('BULLISH','BEARISH','NEUTRAL')),
  current_stance     text not null check (current_stance  in ('BULLISH','BEARISH','NEUTRAL')),
  previous_event_at  timestamptz not null,
  current_event_at   timestamptz not null,
  gap_days           integer not null,
  flip_type          text not null check (flip_type in
                       ('BEAR_TO_BULL','BULL_TO_BEAR','NEUTRAL_TO_BULL','NEUTRAL_TO_BEAR','BULL_TO_NEUTRAL','BEAR_TO_NEUTRAL')),
  strength           text not null check (strength in ('STRONG','MEDIUM','WEAK')),
  confidence         numeric,
  push_eligible      boolean not null default false,
  source_grade       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  notified_at        timestamptz,
  unique (person_id, symbol, previous_event_id, current_event_id)
);
create index if not exists cfs_recent_idx on consensus_flip_signals(current_event_at desc);
create index if not exists cfs_person_idx on consensus_flip_signals(person_id);
create index if not exists cfs_symbol_idx on consensus_flip_signals(symbol);

-- notification candidates (channel-agnostic; APNs / push wiring is a later phase).
create table if not exists consensus_alert_candidates (
  id             text primary key default gen_random_uuid()::text,
  kind           text not null default 'VIEWPOINT_FLIP',
  flip_signal_id text not null references consensus_flip_signals(id) on delete cascade,
  person_id      text not null references consensus_people(id) on delete cascade,
  symbol         text not null,
  title          text not null,
  body           text not null,
  priority       text not null default 'NORMAL' check (priority in ('HIGH','NORMAL','LOW')),
  created_at     timestamptz not null default now(),
  delivered_at   timestamptz,
  unique (flip_signal_id)
);
create index if not exists cac_undelivered_idx on consensus_alert_candidates(created_at) where delivered_at is null;

-- rollback:
--   drop table if exists consensus_alert_candidates;
--   drop table if exists consensus_flip_signals;
