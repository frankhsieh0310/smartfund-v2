-- DRAFT — NOT applied to any database. Deliberately placed outside prisma/migrations/ so
-- `prisma migrate deploy` cannot pick it up by accident. Requires explicit user approval
-- (listed in the single deploy-ask message per this round's working rules) before being
-- moved into prisma/migrations/<timestamp>_add_product_listing_events/migration.sql and run.
--
-- Mirrors the Prisma model `ProductListingEvent` added to prisma/schema.prisma this round.

CREATE TABLE IF NOT EXISTS product_listing_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_type   text NOT NULL,
  code           text NOT NULL,
  name           text NOT NULL,
  event_type     text NOT NULL,
  milestone_date date,
  milestone_kind text,
  source         text NOT NULL,
  source_url     text,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  product_id     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_listing_events_unique UNIQUE (product_type, code, event_type, source)
);

CREATE INDEX IF NOT EXISTS product_listing_events_event_type_detected_at_idx
  ON product_listing_events (event_type, detected_at);

-- Supabase auto-exposes new public-schema tables to anon/authenticated. Per CLAUDE.md's
-- "Supabase RLS" rule, every new table must close that in the same change:
ALTER TABLE product_listing_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON product_listing_events FROM anon, authenticated;

-- No CREATE POLICY: this table is written/read only by server-side code using the Postgres
-- service-role connection (Prisma via DATABASE_URL/DIRECT_URL), which bypasses RLS entirely.
-- No anon/authenticated access is needed — the App reads this data through the existing
-- Next.js API routes (service-role DB access), never directly from Supabase client-side.
