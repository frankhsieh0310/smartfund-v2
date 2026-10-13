// Minimal, independent persistence for consensusLive — deliberately NOT the old consensus_events /
// consensus_stock_daily / etc. schema (that pipeline stays untouched). Two tables only:
//   consensus_live_source_items — one row per WallStreetCN item ever processed (the dedupe ledger:
//     "same source item id can only ever be extracted once").
//   consensus_live_cards        — one row per merged App-facing card, updated in place as new items
//     join its cluster (never re-created, so the App-facing id stays stable).
// Idempotent (CREATE TABLE IF NOT EXISTS), additive, reversible — same pattern already used
// throughout this repo's db/consensus/*.sql files. Run once per cron invocation; cheap no-op after
// the first run ever creates them.
import type { QueryFn } from "./types";

let ensured = false;

export async function ensureConsensusLiveSchema(query: QueryFn): Promise<void> {
  if (ensured) return;
  await query(
    `create table if not exists consensus_live_source_items (
       source_item_id   bigint primary key,
       source_url       text not null,
       published_at     timestamptz not null,
       processed_at     timestamptz not null default now(),
       qualified        boolean not null,
       speaker_name     text,
       organization     text,
       role             text,
       topic_type       text,
       topic_name       text,
       ticker           text,
       stance           text,
       summary_zh       text,
       reason_zh        text,
       view_changed     boolean not null default false,
       card_id          text
     )`,
    [],
  );
  await query(
    `create index if not exists consensus_live_source_items_card_idx
       on consensus_live_source_items(card_id) where card_id is not null`,
    [],
  );
  await query(
    `create table if not exists consensus_live_cards (
       id                 text primary key,
       speaker_name       text not null,
       organization       text not null,
       role               text,
       topic_type         text not null,
       topic_name         text not null,
       ticker             text,
       stance             text not null,
       summary_zh         text not null,
       reason_zh          text not null,
       view_changed       boolean not null default false,
       published_at       timestamptz not null,
       source_label       text not null default '華爾街見聞',
       source_urls        jsonb not null default '[]'::jsonb,
       source_item_count  integer not null default 1,
       created_at         timestamptz not null default now(),
       updated_at         timestamptz not null default now()
     )`,
    [],
  );
  await query(`create index if not exists consensus_live_cards_published_idx on consensus_live_cards(published_at desc)`, []);
  ensured = true;
}
