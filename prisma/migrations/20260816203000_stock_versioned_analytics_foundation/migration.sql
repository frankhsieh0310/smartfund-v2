CREATE TYPE "StockAnalyticsTimeframe" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');
CREATE TYPE "StockAnalyticsMetricKind" AS ENUM ('NUMERIC_METRIC', 'STATE_METRIC');
CREATE TYPE "StockSeasonalityType" AS ENUM ('MONTH_OF_YEAR', 'DAY_OF_WEEK', 'QUARTER', 'TURN_OF_MONTH', 'ROLLING_HIT_RATE', 'FORWARD_RETURN', 'RETURN_DISTRIBUTION', 'TAIL_METRIC');

CREATE TABLE "stock_analytics" (
  "id" UUID NOT NULL,
  "stock_id" TEXT NOT NULL,
  "as_of" DATE NOT NULL,
  "timeframe" "StockAnalyticsTimeframe" NOT NULL,
  "metric_key" TEXT NOT NULL,
  "metric_kind" "StockAnalyticsMetricKind" NOT NULL,
  "window" INTEGER NOT NULL DEFAULT 0,
  "calculation_version" TEXT NOT NULL,
  "value" DECIMAL(30,12),
  "value_2" DECIMAL(30,12),
  "value_3" DECIMAL(30,12),
  "state_value" TEXT,
  "source_input_version" TEXT NOT NULL,
  "known_at" TIMESTAMPTZ(6) NOT NULL,
  "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "stock_analytics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_analytics_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stocks"("id") ON DELETE CASCADE,
  CONSTRAINT "stock_analytics_window_check" CHECK ("window" >= 0),
  CONSTRAINT "stock_analytics_pit_check" CHECK ("known_at" >= "as_of"::timestamp),
  CONSTRAINT "stock_analytics_value_kind_check" CHECK (
    ("metric_kind" = 'NUMERIC_METRIC' AND "value" IS NOT NULL AND "state_value" IS NULL)
    OR ("metric_kind" = 'STATE_METRIC' AND "value" IS NULL AND "value_2" IS NULL AND "value_3" IS NULL AND "state_value" IS NOT NULL)
  ),
  CONSTRAINT "stock_analytics_grain_key" UNIQUE ("stock_id","as_of","timeframe","metric_key","window","calculation_version")
);
CREATE INDEX "stock_analytics_stock_asof_timeframe_idx" ON "stock_analytics"("stock_id","as_of","timeframe");
CREATE INDEX "stock_analytics_stock_metric_timeframe_asof_idx" ON "stock_analytics"("stock_id","metric_key","timeframe","as_of");
CREATE INDEX "stock_analytics_metric_timeframe_asof_idx" ON "stock_analytics"("metric_key","timeframe","as_of");

CREATE TABLE "stock_seasonality" (
  "id" UUID NOT NULL,
  "stock_id" TEXT NOT NULL,
  "as_of" DATE NOT NULL,
  "seasonality_type" "StockSeasonalityType" NOT NULL,
  "bucket" TEXT NOT NULL,
  "lookback_window" INTEGER NOT NULL,
  "sample_count" INTEGER NOT NULL,
  "calculation_version" TEXT NOT NULL,
  "mean_return" DECIMAL(30,12),
  "median_return" DECIMAL(30,12),
  "hit_rate" DECIMAL(30,12),
  "std_dev" DECIMAL(30,12),
  "min_return" DECIMAL(30,12),
  "max_return" DECIMAL(30,12),
  "source_input_version" TEXT NOT NULL,
  "known_at" TIMESTAMPTZ(6) NOT NULL,
  "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "stock_seasonality_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_seasonality_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stocks"("id") ON DELETE CASCADE,
  CONSTRAINT "stock_seasonality_window_check" CHECK ("lookback_window" > 0),
  CONSTRAINT "stock_seasonality_sample_check" CHECK ("sample_count" >= 0),
  CONSTRAINT "stock_seasonality_pit_check" CHECK ("known_at" >= "as_of"::timestamp),
  CONSTRAINT "stock_seasonality_grain_key" UNIQUE ("stock_id","as_of","seasonality_type","bucket","lookback_window","calculation_version")
);
CREATE INDEX "stock_seasonality_stock_type_asof_idx" ON "stock_seasonality"("stock_id","seasonality_type","as_of");
CREATE INDEX "stock_seasonality_stock_type_bucket_asof_idx" ON "stock_seasonality"("stock_id","seasonality_type","bucket","as_of");
