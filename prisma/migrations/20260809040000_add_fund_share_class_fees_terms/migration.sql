ALTER TABLE "fund_share_classes"
  ADD COLUMN "distribution_frequency" TEXT,
  ADD COLUMN "accumulating_distributing" TEXT,
  ADD COLUMN "hedged" BOOLEAN,
  ADD COLUMN "institutional_retail" TEXT,
  ADD COLUMN "share_class_type" TEXT,
  ADD COLUMN "management_fee" DECIMAL(10,8),
  ADD COLUMN "ongoing_charges" DECIMAL(10,8),
  ADD COLUMN "ter" DECIMAL(10,8),
  ADD COLUMN "sales_charge_front" DECIMAL(10,8),
  ADD COLUMN "sales_charge_back" DECIMAL(10,8),
  ADD COLUMN "redemption_fee" DECIMAL(10,8),
  ADD COLUMN "performance_fee" DECIMAL(10,8),
  ADD COLUMN "minimum_initial_investment" DECIMAL(24,4),
  ADD COLUMN "minimum_additional_investment" DECIMAL(24,4),
  ADD COLUMN "terms_source" TEXT,
  ADD COLUMN "terms_source_record_id" TEXT,
  ADD COLUMN "terms_as_of_date" DATE;

CREATE INDEX "fund_share_classes_terms_source_terms_as_of_date_idx"
  ON "fund_share_classes"("terms_source", "terms_as_of_date");
