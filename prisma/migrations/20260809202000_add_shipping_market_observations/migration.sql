CREATE TABLE "shipping_market_observations" (
    "id" UUID NOT NULL,
    "market_or_region" TEXT NOT NULL,
    "indicator" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "value" DECIMAL(30,10) NOT NULL,
    "unit" TEXT NOT NULL,
    "currency" TEXT,
    "frequency" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_market_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipping_market_observations_region_indicator_date_source_key"
ON "shipping_market_observations"("market_or_region", "indicator", "observation_date", "source");

CREATE INDEX "shipping_market_observations_indicator_observation_date_idx"
ON "shipping_market_observations"("indicator", "observation_date");
