ALTER TABLE "holdings"
  ADD COLUMN "share_class_id" TEXT,
  ADD COLUMN "isin" TEXT,
  ADD COLUMN "cusip" TEXT,
  ADD COLUMN "ticker" TEXT,
  ADD COLUMN "amount" DECIMAL(24,8),
  ADD COLUMN "shares" DECIMAL(24,8),
  ADD COLUMN "market_value" DECIMAL(24,4),
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "source_record_id" TEXT,
  ADD COLUMN "filing_id" TEXT,
  ADD COLUMN "weight_method" TEXT;

ALTER TABLE "holdings"
  ADD CONSTRAINT "holdings_share_class_id_fkey"
  FOREIGN KEY ("share_class_id") REFERENCES "fund_share_classes"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "holdings_share_class_id_as_of_date_idx"
  ON "holdings"("share_class_id", "as_of_date");

CREATE INDEX "holdings_source_filing_id_idx"
  ON "holdings"("source", "filing_id");

CREATE UNIQUE INDEX "holdings_fund_source_filing_record_key"
  ON "holdings"("fund_id", "source", "filing_id", "source_record_id")
  WHERE "fund_id" IS NOT NULL AND "source" IS NOT NULL
    AND "filing_id" IS NOT NULL AND "source_record_id" IS NOT NULL;
