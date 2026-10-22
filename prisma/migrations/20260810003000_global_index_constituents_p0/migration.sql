CREATE TABLE IF NOT EXISTS "index_constituent_snapshots" (
  "id" text PRIMARY KEY, "index_id" text NOT NULL, "effective_date" date NOT NULL,
  "as_of_date" date, "publication_date" date, "provider_id" text,
  "source" text NOT NULL, "source_type" text NOT NULL, "source_url" text NOT NULL,
  "source_record_id" text, "retrieved_at" timestamptz NOT NULL, "checksum" text,
  "source_row_count" integer, "parsed_row_count" integer NOT NULL, "canonical_row_count" integer NOT NULL,
  "constituent_count" integer, "known_weight_count" integer NOT NULL DEFAULT 0,
  "known_weight_sum" numeric(20,10), "unknown_weight_count" integer NOT NULL DEFAULT 0,
  "completeness_status" text NOT NULL, "verification_status" text NOT NULL,
  "license_status" text NOT NULL, "quality_status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "index_constituent_snapshots_dedupe_key" UNIQUE ("index_id","effective_date","source","checksum")
);
CREATE INDEX IF NOT EXISTS "index_constituent_snapshots_index_effective_idx" ON "index_constituent_snapshots"("index_id","effective_date");
CREATE INDEX IF NOT EXISTS "index_constituent_snapshots_verification_idx" ON "index_constituent_snapshots"("verification_status","effective_date");

CREATE TABLE IF NOT EXISTS "index_constituents" (
  "id" text PRIMARY KEY, "snapshot_id" text NOT NULL REFERENCES "index_constituent_snapshots"("id") ON DELETE CASCADE,
  "index_id" text NOT NULL, "security_id" text REFERENCES "securities"("id") ON DELETE SET NULL,
  "identity_key" text NOT NULL, "constituent_name" text NOT NULL, "ticker" text,
  "isin" text, "cusip" text, "sedol" text, "figi" text, "exchange" text,
  "country" text, "currency" text, "source_weight" numeric(20,10),
  "normalized_weight" numeric(20,10), "weight_unit" text, "shares" numeric(30,8),
  "free_float_factor" numeric(20,10), "market_cap" numeric(30,4), "source_row_id" text,
  "verification_status" text NOT NULL, "quality_status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "index_constituents_snapshot_identity_key" UNIQUE ("snapshot_id","identity_key")
);
CREATE INDEX IF NOT EXISTS "index_constituents_index_ticker_idx" ON "index_constituents"("index_id","ticker");
CREATE INDEX IF NOT EXISTS "index_constituents_security_idx" ON "index_constituents"("security_id");
CREATE INDEX IF NOT EXISTS "index_constituents_isin_idx" ON "index_constituents"("isin");

CREATE TABLE IF NOT EXISTS "index_constituent_mapping_queue" (
  "id" text PRIMARY KEY, "snapshot_id" text NOT NULL REFERENCES "index_constituent_snapshots"("id") ON DELETE CASCADE,
  "constituent_id" text NOT NULL REFERENCES "index_constituents"("id") ON DELETE CASCADE,
  "status" text NOT NULL, "match_method" text, "candidate_security_ids" jsonb, "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "index_constituent_mapping_queue_snapshot_constituent_key" UNIQUE ("snapshot_id","constituent_id")
);
CREATE INDEX IF NOT EXISTS "index_constituent_mapping_queue_status_idx" ON "index_constituent_mapping_queue"("status","updated_at");

CREATE TABLE IF NOT EXISTS "index_constituent_events" (
  "id" text PRIMARY KEY, "index_id" text NOT NULL, "security_id" text,
  "constituent_identity_fallback" text NOT NULL, "event_type" text NOT NULL, "effective_date" date NOT NULL,
  "previous_snapshot_id" text REFERENCES "index_constituent_snapshots"("id") ON DELETE SET NULL,
  "current_snapshot_id" text NOT NULL REFERENCES "index_constituent_snapshots"("id") ON DELETE CASCADE,
  "previous_weight" numeric(20,10), "current_weight" numeric(20,10), "weight_change" numeric(20,10),
  "weight_change_pct" numeric(20,10), "source_type" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "index_constituent_events_dedupe_key" UNIQUE ("current_snapshot_id","constituent_identity_fallback","event_type")
);
CREATE INDEX IF NOT EXISTS "index_constituent_events_index_effective_idx" ON "index_constituent_events"("index_id","effective_date");
