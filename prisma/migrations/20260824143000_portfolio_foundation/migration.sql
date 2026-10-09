-- Additive, data-preserving shared Web/Mobile virtual portfolio foundation.
-- Preserve legacy AssetType values while adding the canonical mobile domains.
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'STOCK';
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'INDEX';
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'DERIVATIVES';
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'FIXED_INCOME';
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'FX';
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'MACRO';
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'COMMODITY';
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'CRYPTO';
ALTER TABLE "portfolios" ADD COLUMN IF NOT EXISTS "benchmark_asset_type" "AssetType";
ALTER TABLE "portfolios" ADD COLUMN IF NOT EXISTS "benchmark_asset_id" TEXT;
ALTER TABLE "portfolios" ADD COLUMN IF NOT EXISTS "settings" JSONB;
ALTER TABLE "portfolios" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);
ALTER TABLE "portfolio_items" ALTER COLUMN "weight" DROP NOT NULL;
ALTER TABLE "portfolio_items" ALTER COLUMN "weight" TYPE DECIMAL(10,6);
ALTER TABLE "portfolio_items" ALTER COLUMN "shares" TYPE DECIMAL(28,10);
ALTER TABLE "portfolio_items" ALTER COLUMN "avg_cost" TYPE DECIMAL(28,10);
ALTER TABLE "portfolio_items" ADD COLUMN IF NOT EXISTS "cost_basis" DECIMAL(28,10);
ALTER TABLE "portfolio_items" ADD COLUMN IF NOT EXISTS "realized_pnl" DECIMAL(28,10) NOT NULL DEFAULT 0;

DO $$ BEGIN CREATE TYPE "PortfolioTransactionType" AS ENUM ('BUY','SELL','DIVIDEND','INTEREST','FEE','TAX','DEPOSIT','WITHDRAWAL','TRANSFER_IN','TRANSFER_OUT','SPLIT','ADJUSTMENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PortfolioLotStatus" AS ENUM ('OPEN','CLOSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DataAvailability" AS ENUM ('AVAILABLE','PARTIAL','UPDATING','SCHEDULED_WAIT','SOURCE_LIMITED','NOT_AVAILABLE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "portfolio_transactions" (
 "id" TEXT PRIMARY KEY, "portfolio_id" TEXT NOT NULL REFERENCES "portfolios"("id") ON DELETE CASCADE,
 "type" "PortfolioTransactionType" NOT NULL, "asset_type" "AssetType", "asset_id" TEXT,
 "quantity" DECIMAL(28,10), "price" DECIMAL(28,10), "amount" DECIMAL(28,10) NOT NULL,
 "fees" DECIMAL(28,10) NOT NULL DEFAULT 0, "tax" DECIMAL(28,10) NOT NULL DEFAULT 0,
 "currency" TEXT NOT NULL, "fx_rate_to_base" DECIMAL(28,10), "occurred_at" TIMESTAMP(3) NOT NULL,
 "note" TEXT, "idempotency_key" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "portfolio_transactions_asset_pair" CHECK (("asset_type" IS NULL) = ("asset_id" IS NULL)),
 CONSTRAINT "portfolio_transactions_trade_fields" CHECK ("type" NOT IN ('BUY','SELL') OR ("asset_type" IS NOT NULL AND "quantity" > 0 AND "price" >= 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS "portfolio_transactions_portfolio_id_idempotency_key_key" ON "portfolio_transactions"("portfolio_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "portfolio_transactions_portfolio_id_occurred_at_idx" ON "portfolio_transactions"("portfolio_id","occurred_at");
CREATE INDEX IF NOT EXISTS "portfolio_transactions_asset_type_asset_id_idx" ON "portfolio_transactions"("asset_type","asset_id");

CREATE TABLE IF NOT EXISTS "portfolio_tax_lots" (
 "id" TEXT PRIMARY KEY, "portfolio_id" TEXT NOT NULL REFERENCES "portfolios"("id") ON DELETE CASCADE,
 "transaction_id" TEXT NOT NULL REFERENCES "portfolio_transactions"("id") ON DELETE RESTRICT,
 "asset_type" "AssetType" NOT NULL, "asset_id" TEXT NOT NULL, "acquired_at" TIMESTAMP(3) NOT NULL,
 "original_quantity" DECIMAL(28,10) NOT NULL, "remaining_quantity" DECIMAL(28,10) NOT NULL,
 "unit_cost" DECIMAL(28,10) NOT NULL, "currency" TEXT NOT NULL, "fx_rate_to_base" DECIMAL(28,10),
 "status" "PortfolioLotStatus" NOT NULL DEFAULT 'OPEN', "closed_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "portfolio_tax_lots_quantities" CHECK ("original_quantity" > 0 AND "remaining_quantity" >= 0 AND "remaining_quantity" <= "original_quantity")
);
CREATE INDEX IF NOT EXISTS "portfolio_tax_lots_fifo_idx" ON "portfolio_tax_lots"("portfolio_id","asset_type","asset_id","status","acquired_at");

CREATE TABLE IF NOT EXISTS "portfolio_cash_balances" (
 "id" TEXT PRIMARY KEY, "portfolio_id" TEXT NOT NULL REFERENCES "portfolios"("id") ON DELETE CASCADE,
 "currency" TEXT NOT NULL, "balance" DECIMAL(28,10) NOT NULL DEFAULT 0, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("portfolio_id","currency")
);
CREATE TABLE IF NOT EXISTS "portfolio_valuation_snapshots" (
 "id" TEXT PRIMARY KEY, "portfolio_id" TEXT NOT NULL REFERENCES "portfolios"("id") ON DELETE CASCADE,
 "as_of" TIMESTAMP(3) NOT NULL, "total_value" DECIMAL(28,10) NOT NULL, "cash_value" DECIMAL(28,10) NOT NULL,
 "cost_basis" DECIMAL(28,10) NOT NULL, "realized_pnl" DECIMAL(28,10) NOT NULL, "unrealized_pnl" DECIMAL(28,10) NOT NULL,
 "net_contributions" DECIMAL(28,10) NOT NULL, "benchmark_value" DECIMAL(28,10), "allocation" JSONB,
 "availability" "DataAvailability" NOT NULL DEFAULT 'PARTIAL', UNIQUE("portfolio_id","as_of")
);
CREATE TABLE IF NOT EXISTS "portfolio_events" (
 "id" TEXT PRIMARY KEY, "portfolio_id" TEXT NOT NULL REFERENCES "portfolios"("id") ON DELETE CASCADE,
 "type" TEXT NOT NULL, "payload" JSONB NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "portfolio_events_portfolio_id_created_at_idx" ON "portfolio_events"("portfolio_id","created_at");
GRANT SELECT, INSERT, UPDATE, DELETE ON "portfolio_transactions", "portfolio_tax_lots", "portfolio_cash_balances", "portfolio_valuation_snapshots", "portfolio_events" TO authenticated;

DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['portfolio_transactions','portfolio_tax_lots','portfolio_cash_balances','portfolio_valuation_snapshots','portfolio_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY portfolio_select_own ON %I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM portfolios p JOIN users u ON u.id=p.user_id WHERE p.id=%I.portfolio_id AND u.supabase_id=(SELECT auth.uid())::text))',t,t);
  EXECUTE format('CREATE POLICY portfolio_insert_own ON %I FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM portfolios p JOIN users u ON u.id=p.user_id WHERE p.id=%I.portfolio_id AND u.supabase_id=(SELECT auth.uid())::text))',t,t);
  EXECUTE format('CREATE POLICY portfolio_update_own ON %I FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM portfolios p JOIN users u ON u.id=p.user_id WHERE p.id=%I.portfolio_id AND u.supabase_id=(SELECT auth.uid())::text)) WITH CHECK (EXISTS (SELECT 1 FROM portfolios p JOIN users u ON u.id=p.user_id WHERE p.id=%I.portfolio_id AND u.supabase_id=(SELECT auth.uid())::text))',t,t,t);
  EXECUTE format('CREATE POLICY portfolio_delete_own ON %I FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM portfolios p JOIN users u ON u.id=p.user_id WHERE p.id=%I.portfolio_id AND u.supabase_id=(SELECT auth.uid())::text))',t,t);
 END LOOP;
END $$;
