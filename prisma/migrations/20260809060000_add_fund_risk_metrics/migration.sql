CREATE TABLE "fund_risk_metrics" (
  "id" TEXT NOT NULL, "fund_id" TEXT NOT NULL, "share_class_id" TEXT,
  "metric_code" TEXT NOT NULL, "period" TEXT NOT NULL, "value" DECIMAL(24,10) NOT NULL,
  "as_of_date" DATE NOT NULL, "currency" TEXT, "calculation_method" TEXT NOT NULL,
  "observation_count" INTEGER NOT NULL, "source" TEXT NOT NULL, "return_semantics" TEXT,
  "start_date" DATE, "end_date" DATE, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fund_risk_metrics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fund_risk_metrics_fund_id_fkey" FOREIGN KEY ("fund_id") REFERENCES "funds"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fund_risk_metrics_share_class_id_fkey" FOREIGN KEY ("share_class_id") REFERENCES "fund_share_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "fund_risk_metrics_identity_key" ON "fund_risk_metrics"("fund_id","share_class_id","metric_code","as_of_date","source","calculation_method");
CREATE INDEX "fund_risk_metrics_fund_id_as_of_date_idx" ON "fund_risk_metrics"("fund_id","as_of_date");
CREATE INDEX "fund_risk_metrics_metric_code_as_of_date_idx" ON "fund_risk_metrics"("metric_code","as_of_date");
