CREATE TABLE "credit_derivative_observations" (
    "id" UUID NOT NULL,
    "market" TEXT NOT NULL,
    "instrument_type" TEXT NOT NULL,
    "instrument_id" TEXT,
    "reference_entity" TEXT,
    "observation_date" DATE NOT NULL,
    "metric_type" TEXT NOT NULL,
    "value" DECIMAL(30,6) NOT NULL,
    "unit" TEXT NOT NULL,
    "currency" TEXT,
    "source" TEXT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_derivative_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_derivative_observations_source_instrument_id_observation_date_metric_type_key"
ON "credit_derivative_observations"("source", "instrument_id", "observation_date", "metric_type");

CREATE INDEX "credit_derivative_observations_market_observation_date_idx"
ON "credit_derivative_observations"("market", "observation_date");
