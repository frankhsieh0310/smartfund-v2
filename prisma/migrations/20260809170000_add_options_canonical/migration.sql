CREATE TABLE "option_contracts" (
    "id" UUID NOT NULL,
    "underlying" TEXT NOT NULL,
    "underlying_type" TEXT NOT NULL,
    "underlying_identity" JSONB NOT NULL,
    "exchange" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "multiplier" INTEGER NOT NULL,
    "contract_symbol" TEXT NOT NULL,
    "expiration" DATE NOT NULL,
    "strike" DECIMAL(24,8) NOT NULL,
    "call_put" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "option_contracts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "option_observations" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "bid" DECIMAL(24,8),
    "ask" DECIMAL(24,8),
    "last" DECIMAL(24,8),
    "volume" BIGINT,
    "open_interest" BIGINT,
    "implied_volatility" DECIMAL(24,10),
    "source" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "option_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "option_contracts_contract_symbol_key" ON "option_contracts"("contract_symbol");
CREATE INDEX "option_contracts_underlying_expiration_idx" ON "option_contracts"("underlying", "expiration");
CREATE UNIQUE INDEX "option_observations_source_key_key" ON "option_observations"("source_key");
CREATE UNIQUE INDEX "option_observations_contract_id_observed_at_key" ON "option_observations"("contract_id", "observed_at");
CREATE INDEX "option_observations_observed_at_idx" ON "option_observations"("observed_at");
ALTER TABLE "option_observations" ADD CONSTRAINT "option_observations_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "option_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
