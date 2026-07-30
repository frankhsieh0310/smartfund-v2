CREATE TABLE "stock_financial_facts" (
  "id" TEXT NOT NULL,
  "stock_id" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "period_start" DATE,
  "period_end" DATE NOT NULL,
  "fiscal_period" TEXT,
  "form_type" TEXT,
  "filing_date" DATE,
  "publication_date" DATE,
  "value" DECIMAL(30,8) NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "source" TEXT NOT NULL,
  "source_fact_key" TEXT NOT NULL,
  "source_document_url" TEXT,
  "restatement_version" TEXT,
  "imported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "stock_financial_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_financial_facts_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "stock_financial_facts_stock_id_metric_period_end_source_source_fact_key_key"
  ON "stock_financial_facts"("stock_id", "metric", "period_end", "source", "source_fact_key");
CREATE INDEX "stock_financial_facts_stock_id_metric_period_end_idx"
  ON "stock_financial_facts"("stock_id", "metric", "period_end");
CREATE INDEX "stock_financial_facts_metric_period_end_idx"
  ON "stock_financial_facts"("metric", "period_end");
CREATE INDEX "stock_financial_facts_source_publication_date_idx"
  ON "stock_financial_facts"("source", "publication_date");
