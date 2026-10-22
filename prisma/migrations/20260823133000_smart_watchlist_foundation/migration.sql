CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "watchlists" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "owner_user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "timezone" TEXT,
  "is_test" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS "watchlist_items" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "watchlist_id" TEXT NOT NULL REFERENCES "watchlists"("id") ON DELETE CASCADE,
  "asset_type" TEXT NOT NULL,
  "canonical_asset_id" TEXT NOT NULL,
  "display_symbol" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removed_at" TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS "watchlist_membership_events" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "watchlist_item_id" TEXT NOT NULL REFERENCES "watchlist_items"("id") ON DELETE CASCADE,
  "event_type" TEXT NOT NULL,
  "effective_at" TIMESTAMP(3) NOT NULL,
  "actor_user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "watchlists"
  ADD COLUMN IF NOT EXISTS "default_lens" TEXT NOT NULL DEFAULT 'MARKET',
  ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "is_default" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "watchlist_items"
  ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "is_pinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "note" TEXT,
  ADD COLUMN IF NOT EXISTS "tags" JSONB,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "watchlists_owner_default_key"
  ON "watchlists"("owner_user_id") WHERE "is_default" = true AND "archived_at" IS NULL;
CREATE INDEX IF NOT EXISTS "watchlists_owner_order_idx" ON "watchlists"("owner_user_id", "sort_order", "created_at");
CREATE INDEX IF NOT EXISTS "watchlist_items_order_idx" ON "watchlist_items"("watchlist_id", "is_pinned", "sort_order", "created_at");
CREATE INDEX IF NOT EXISTS "watchlist_membership_events_actor_time_idx" ON "watchlist_membership_events"("actor_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "watchlists_owner_user_id_status_idx" ON "watchlists"("owner_user_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "watchlist_items_active_identity_key" ON "watchlist_items"("watchlist_id", "asset_type", "canonical_asset_id") WHERE "removed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "watchlist_items_asset_fanout_idx" ON "watchlist_items"("asset_type", "canonical_asset_id", "status");
CREATE INDEX IF NOT EXISTS "watchlist_membership_events_item_effective_idx" ON "watchlist_membership_events"("watchlist_item_id", "effective_at");

ALTER TABLE "watchlists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "watchlist_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "watchlist_membership_events" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "watchlists_owner_all" ON "watchlists";
CREATE POLICY "watchlists_owner_all" ON "watchlists" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "owner_user_id" AND u."supabase_id" = auth.uid()::text))
  WITH CHECK (EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "owner_user_id" AND u."supabase_id" = auth.uid()::text));

DROP POLICY IF EXISTS "watchlist_items_owner_all" ON "watchlist_items";
CREATE POLICY "watchlist_items_owner_all" ON "watchlist_items" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "watchlists" w JOIN "users" u ON u."id" = w."owner_user_id" WHERE w."id" = "watchlist_id" AND u."supabase_id" = auth.uid()::text))
  WITH CHECK (EXISTS (SELECT 1 FROM "watchlists" w JOIN "users" u ON u."id" = w."owner_user_id" WHERE w."id" = "watchlist_id" AND u."supabase_id" = auth.uid()::text));

DROP POLICY IF EXISTS "watchlist_events_owner_all" ON "watchlist_membership_events";
CREATE POLICY "watchlist_events_owner_all" ON "watchlist_membership_events" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "watchlist_items" i JOIN "watchlists" w ON w."id" = i."watchlist_id" JOIN "users" u ON u."id" = w."owner_user_id" WHERE i."id" = "watchlist_item_id" AND u."supabase_id" = auth.uid()::text))
  WITH CHECK (EXISTS (SELECT 1 FROM "watchlist_items" i JOIN "watchlists" w ON w."id" = i."watchlist_id" JOIN "users" u ON u."id" = w."owner_user_id" WHERE i."id" = "watchlist_item_id" AND u."supabase_id" = auth.uid()::text AND "actor_user_id" = u."id"));

REVOKE ALL ON "watchlists", "watchlist_items", "watchlist_membership_events" FROM anon;
REVOKE ALL ON "watchlists", "watchlist_items", "watchlist_membership_events" FROM PUBLIC;
REVOKE ALL ON "watchlists", "watchlist_items", "watchlist_membership_events" FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "watchlists", "watchlist_items", "watchlist_membership_events" TO authenticated;
