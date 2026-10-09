ALTER TABLE "index_constituent_mapping_queue"
  ADD COLUMN IF NOT EXISTS "source_identifier" text,
  ADD COLUMN IF NOT EXISTS "canonical_identifier" text,
  ADD COLUMN IF NOT EXISTS "verification_source" text,
  ADD COLUMN IF NOT EXISTS "verified_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "mapping_version" text NOT NULL DEFAULT '1.0.0';
