ALTER TABLE "fund_provider_mappings"
  ADD COLUMN "source" TEXT,
  ADD COLUMN "mapping_method" TEXT,
  ADD COLUMN "verified_at" TIMESTAMP(3),
  ADD COLUMN "share_class_id" TEXT;

ALTER TABLE "fund_provider_mappings"
  ADD CONSTRAINT "fund_provider_mappings_share_class_id_fkey"
  FOREIGN KEY ("share_class_id") REFERENCES "fund_share_classes"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "fund_provider_mappings_share_class_id_idx"
  ON "fund_provider_mappings"("share_class_id");

CREATE INDEX "fund_provider_mappings_verified_at_idx"
  ON "fund_provider_mappings"("verified_at");
