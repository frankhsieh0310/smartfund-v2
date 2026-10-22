CREATE TABLE "futures_positioning_observations" (
    "id" UUID NOT NULL, "report_type" TEXT NOT NULL, "universe_group" TEXT NOT NULL,
    "market" TEXT NOT NULL, "report_date" DATE NOT NULL, "category" TEXT NOT NULL,
    "long_value" BIGINT, "short_value" BIGINT, "spreading_value" BIGINT, "net_value" BIGINT,
    "open_interest" BIGINT, "source" TEXT NOT NULL, "source_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "futures_positioning_observations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "futures_positioning_observations_source_key_key" ON "futures_positioning_observations"("source_key");
CREATE INDEX "futures_positioning_observations_report_type_report_date_idx" ON "futures_positioning_observations"("report_type", "report_date");
CREATE INDEX "futures_positioning_observations_market_report_date_idx" ON "futures_positioning_observations"("market", "report_date");
