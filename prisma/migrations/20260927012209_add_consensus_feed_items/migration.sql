-- Function 3 (大佬觀點・共識雷達) — WallStreetCN 7x24 live-feed important items (score >= 2, the
-- source's own importance marking, never re-invented by us). One row per raw feed item; person-
-- attributed items also get item_type='PERSON_VIEWPOINT' with the matched person filled in.
-- Identity: (source, external_id) is unique — a re-run upserts in place, never duplicates.

CREATE TABLE IF NOT EXISTS "consensus_feed_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "source" text NOT NULL DEFAULT 'WALLSTREETCN',
  "external_id" text NOT NULL,
  "published_at" timestamptz NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "score" integer NOT NULL,
  "channel" text[] NOT NULL DEFAULT '{}',
  "source_url" text NOT NULL,
  "item_type" text NOT NULL, -- PERSON_VIEWPOINT | IMPORTANT_EVENT
  "person_slug" text,
  "person_display_name" text,
  "related_tickers" text[] NOT NULL DEFAULT '{}',
  "related_companies" text[] NOT NULL DEFAULT '{}',
  "related_industries" text[] NOT NULL DEFAULT '{}',
  "stance" text, -- only ever set from an explicit, unambiguous statement in the source; never inferred
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "consensus_feed_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "consensus_feed_items_source_external_key" UNIQUE ("source", "external_id")
);

CREATE INDEX IF NOT EXISTS "consensus_feed_items_published_idx" ON "consensus_feed_items" ("published_at" DESC);
CREATE INDEX IF NOT EXISTS "consensus_feed_items_item_type_idx" ON "consensus_feed_items" ("item_type", "published_at" DESC);
CREATE INDEX IF NOT EXISTS "consensus_feed_items_person_idx" ON "consensus_feed_items" ("person_slug") WHERE "person_slug" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "consensus_feed_items_tickers_idx" ON "consensus_feed_items" USING GIN ("related_tickers");
