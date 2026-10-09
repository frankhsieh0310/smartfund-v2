CREATE TABLE "securities_lending_observations" (
    "id" UUID NOT NULL,
    "stock_id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "metric_type" TEXT NOT NULL,
    "value" DECIMAL(24,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "securities_lending_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "securities_lending_observations_source_key_key" ON "securities_lending_observations"("source_key");
CREATE UNIQUE INDEX "securities_lending_observations_stock_date_metric_key" ON "securities_lending_observations"("stock_id", "observation_date", "metric_type");
CREATE INDEX "securities_lending_observations_market_date_idx" ON "securities_lending_observations"("market", "observation_date");
ALTER TABLE "securities_lending_observations" ADD CONSTRAINT "securities_lending_observations_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
