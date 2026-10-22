CREATE TABLE "institutional_daily" (
  "id" uuid NOT NULL,
  "date" date NOT NULL,
  "security_id" text NOT NULL,
  "ticker" text NOT NULL,
  "market" text NOT NULL,
  "foreign_buy" numeric(30,4) NOT NULL,
  "foreign_sell" numeric(30,4) NOT NULL,
  "foreign_net" numeric(30,4) NOT NULL,
  "trust_buy" numeric(30,4) NOT NULL,
  "trust_sell" numeric(30,4) NOT NULL,
  "trust_net" numeric(30,4) NOT NULL,
  "dealer_buy" numeric(30,4) NOT NULL,
  "dealer_sell" numeric(30,4) NOT NULL,
  "dealer_net" numeric(30,4) NOT NULL,
  "total_net" numeric(30,4) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "institutional_daily_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "institutional_daily_security_id_fkey" FOREIGN KEY ("security_id") REFERENCES "securities"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "institutional_daily_date_security_id_key" ON "institutional_daily"("date", "security_id");
CREATE INDEX "institutional_daily_date_idx" ON "institutional_daily"("date");
CREATE INDEX "institutional_daily_security_id_idx" ON "institutional_daily"("security_id");
CREATE INDEX "institutional_daily_ticker_idx" ON "institutional_daily"("ticker");
CREATE INDEX "institutional_daily_market_idx" ON "institutional_daily"("market");
