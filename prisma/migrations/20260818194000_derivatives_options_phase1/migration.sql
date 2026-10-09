ALTER TABLE "option_observations"
  ADD COLUMN IF NOT EXISTS "trade_date" DATE,
  ADD COLUMN IF NOT EXISTS "open" DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS "high" DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS "low" DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS "close" DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS "underlying_price" DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS "moneyness" DECIMAL(24,10),
  ADD COLUMN IF NOT EXISTS "intrinsic_value" DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS "extrinsic_value" DECIMAL(24,8);

CREATE INDEX IF NOT EXISTS "option_observations_trade_date_idx" ON "option_observations"("trade_date");
