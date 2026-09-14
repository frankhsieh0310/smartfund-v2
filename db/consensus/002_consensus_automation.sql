-- 共識雷達 Phase 2 — automation: AI extraction cache + per-source health/self-healing.
-- Additive, reversible.

create extension if not exists pgcrypto;

-- STEP 3 — AI extraction cache. Keyed by (content_hash, extraction_version, model) so an unchanged
-- statement is never re-sent to a model.
create table if not exists consensus_ai_cache (
  content_hash        text not null,
  extraction_version  text not null,
  model               text not null,
  status              text not null check (status in ('CLASSIFIED','NEEDS_REVIEW','REJECTED')),
  result              jsonb,
  reason              text,
  prompt_tokens       integer,
  completion_tokens   integer,
  created_at          timestamptz not null default now(),
  primary key (content_hash, extraction_version, model)
);
create index if not exists consensus_ai_cache_created_idx on consensus_ai_cache(created_at desc);

-- STEP 7 / 12 — per-source incremental state + self-healing.
alter table consensus_sources add column if not exists status               text not null default 'ACTIVE'
  check (status in ('ACTIVE','DEGRADED','DISABLED'));
alter table consensus_sources add column if not exists last_success_at       timestamptz;
alter table consensus_sources add column if not exists last_error            text;
alter table consensus_sources add column if not exists last_error_at         timestamptz;
alter table consensus_sources add column if not exists consecutive_failures  integer not null default 0;
alter table consensus_sources add column if not exists next_retry_at         timestamptz;
alter table consensus_sources add column if not exists last_published_at     timestamptz;  -- newest item seen
alter table consensus_sources add column if not exists last_item_url         text;
alter table consensus_sources add column if not exists processed_count       integer not null default 0;

-- Content hash on events (dedup / cache linkage) + extraction bookkeeping.
alter table consensus_events add column if not exists content_hash        text;
alter table consensus_events add column if not exists extraction_version  text;
alter table consensus_events add column if not exists needs_review_reason text;
create index if not exists consensus_events_content_hash_idx on consensus_events(content_hash);
create index if not exists consensus_events_status_idx on consensus_events(extraction_status);
