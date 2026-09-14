-- 共識雷達 Phase 4 — autonomous AI backfill + self-healing. Additive, reversible.
-- One tiny key/value table for AI-gateway health + daily-spend bookkeeping. No rename of any
-- existing column (extraction_status / needs_review_reason / content_hash / extraction_version stay).

create table if not exists consensus_meta (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- backlog lookups: oldest NEEDS_REVIEW first
create index if not exists consensus_events_needs_review_idx
  on consensus_events (created_at)
  where extraction_status = 'NEEDS_REVIEW';

-- rollback:
--   drop index if exists consensus_events_needs_review_idx;
--   drop table if exists consensus_meta;
