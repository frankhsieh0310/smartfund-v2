CREATE TABLE IF NOT EXISTS "futures_contracts" (
  "id" uuid PRIMARY KEY,
  "underlying" text NOT NULL,
  "exchange" text NOT NULL,
  "root_symbol" text NOT NULL,
  "contract_symbol" text NOT NULL,
  "contract_month" date NOT NULL,
  "expiration" date NOT NULL,
  "currency" text NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "futures_contracts_exchange_symbol_key" UNIQUE ("exchange", "contract_symbol")
);
CREATE INDEX IF NOT EXISTS "futures_contracts_root_month_idx" ON "futures_contracts" ("root_symbol", "contract_month");

CREATE TABLE IF NOT EXISTS "futures_observations" (
  "id" uuid PRIMARY KEY,
  "contract_id" uuid NOT NULL REFERENCES "futures_contracts"("id"),
  "observed_at" timestamptz NOT NULL,
  "settlement" numeric(24,8) NOT NULL,
  "source" text NOT NULL,
  "source_key" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "futures_observations_contract_observed_key" UNIQUE ("contract_id", "observed_at")
);
CREATE INDEX IF NOT EXISTS "futures_observations_observed_idx" ON "futures_observations" ("observed_at");
