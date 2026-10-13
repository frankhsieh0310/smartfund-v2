-- 共識雷達 Phase 8 — push delivery channel. Additive, reversible. No AI. No change to `users` /
-- `notifications` / `notification_profiles` (the authed watchlist-alert pipeline is left untouched).
-- Anonymous-capable: keyed by installation_id; owner_user_id can be backfilled later when auth lands.

create table if not exists consensus_push_installations (
  id                    text primary key default gen_random_uuid()::text,
  installation_id       text not null unique,
  owner_user_id         text,
  platform              text not null default 'unknown',     -- ios | android | web | unknown
  push_token            text,
  notifications_enabled boolean not null default false,
  invalid_token         boolean not null default false,
  preferences           jsonb not null default '{}'::jsonb,  -- {flip:true, warming:false, watchlist_only:true}
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);
create index if not exists cpi_enabled_idx on consensus_push_installations(notifications_enabled)
  where notifications_enabled and not invalid_token;

-- delivery subscription mapping (NOT a second watchlist — just which symbols this install wants alerts for).
create table if not exists consensus_push_symbol_subscriptions (
  id              text primary key default gen_random_uuid()::text,
  installation_id text not null,
  symbol          text not null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (installation_id, symbol)
);
create index if not exists cpss_symbol_idx on consensus_push_symbol_subscriptions(symbol) where is_active;

-- one delivery per (alert_candidate, installation) — the double-push guard (a candidate can fan out
-- to many devices, so alert_candidates.delivered_at alone is not enough).
create table if not exists consensus_push_deliveries (
  id                  text primary key default gen_random_uuid()::text,
  alert_candidate_id  text not null references consensus_alert_candidates(id) on delete cascade,
  installation_id     text not null,
  push_token_hash     text,
  status              text not null default 'PENDING'
                        check (status in ('PENDING','DELIVERED','FAILED','INVALID_TOKEN','SKIPPED')),
  attempt_count       integer not null default 0,
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now(),
  delivered_at        timestamptz,
  unique (alert_candidate_id, installation_id)
);
create index if not exists cpd_pending_idx on consensus_push_deliveries(created_at) where status = 'PENDING';

-- anonymous-capable in-app notification record (the App's own notification center; the authed
-- `notifications` table requires user_id and is not touched).
create table if not exists consensus_inapp_notifications (
  id                 text primary key default gen_random_uuid()::text,
  installation_id    text not null,
  owner_user_id      text,
  category           text not null default 'CONSENSUS_FLIP'
                        check (category in ('CONSENSUS_FLIP','CONSENSUS_WARMING')),
  symbol             text not null,
  title              text not null,
  body               text not null,
  route              jsonb not null default '{}'::jsonb,
  flip_signal_id     text,
  alert_candidate_id text,
  is_read            boolean not null default false,
  read_at            timestamptz,
  created_at         timestamptz not null default now(),
  unique (installation_id, alert_candidate_id)
);
create index if not exists cin_unread_idx on consensus_inapp_notifications(installation_id, created_at desc)
  where not is_read;

-- rollback:
--   drop table if exists consensus_inapp_notifications;
--   drop table if exists consensus_push_deliveries;
--   drop table if exists consensus_push_symbol_subscriptions;
--   drop table if exists consensus_push_installations;
