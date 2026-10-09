CREATE TABLE "fund_classifications" (
  "id" TEXT NOT NULL,
  "fund_id" TEXT NOT NULL,
  "share_class_id" TEXT,
  "classification_type" TEXT NOT NULL,
  "classification_code" TEXT,
  "classification_name" TEXT NOT NULL,
  "classification_value" TEXT,
  "source" TEXT NOT NULL,
  "source_record_id" TEXT,
  "as_of_date" DATE,
  "classification_method" TEXT NOT NULL,
  "rating_system" TEXT,
  "benchmark_name" TEXT,
  "benchmark_code" TEXT,
  "benchmark_type" TEXT,
  "benchmark_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fund_classifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fund_classifications_fund_id_fkey" FOREIGN KEY ("fund_id") REFERENCES "funds"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fund_classifications_share_class_id_fkey" FOREIGN KEY ("share_class_id") REFERENCES "fund_share_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "fund_classifications_fund_id_share_class_id_classification_key" ON "fund_classifications" ("fund_id", "share_class_id", "classification_type", "classification_name", "source", "source_record_id");
CREATE INDEX "fund_classifications_fund_id_classification_type_idx" ON "fund_classifications"("fund_id", "classification_type");
CREATE INDEX "fund_classifications_share_class_id_classification_type_idx" ON "fund_classifications"("share_class_id", "classification_type");
CREATE INDEX "fund_classifications_benchmark_id_idx" ON "fund_classifications"("benchmark_id");
CREATE INDEX "fund_classifications_source_as_of_date_idx" ON "fund_classifications"("source", "as_of_date");
