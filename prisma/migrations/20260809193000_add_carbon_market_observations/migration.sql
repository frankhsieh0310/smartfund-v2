CREATE TABLE "carbon_market_observations" (
    "id" UUID NOT NULL,
    "market" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "metric_type" TEXT NOT NULL,
    "value" DECIMAL(24,6) NOT NULL,
    "unit" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carbon_market_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "carbon_market_observations_market_instrument_observation_date_metric_type_key"
ON "carbon_market_observations"("market", "instrument", "observation_date", "metric_type");

CREATE INDEX "carbon_market_observations_market_observation_date_idx"
ON "carbon_market_observations"("market", "observation_date");
