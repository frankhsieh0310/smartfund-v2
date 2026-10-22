CREATE TABLE "company_guidance" (
  "id" UUID NOT NULL,
  "stock_id" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "low_value" DECIMAL(30,8),
  "high_value" DECIMAL(30,8),
  "point_value" DECIMAL(30,8),
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "guidance_period" TEXT NOT NULL,
  "announcement_date" DATE NOT NULL,
  "source" TEXT NOT NULL,
  "filing_id" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "source_text" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "company_guidance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_guidance_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "company_guidance_source_key_key" ON "company_guidance"("source_key");
CREATE INDEX "company_guidance_stock_id_announcement_date_idx" ON "company_guidance"("stock_id", "announcement_date");
CREATE INDEX "company_guidance_metric_announcement_date_idx" ON "company_guidance"("metric", "announcement_date");
