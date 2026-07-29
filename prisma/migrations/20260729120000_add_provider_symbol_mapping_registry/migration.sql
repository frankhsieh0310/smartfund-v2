CREATE TABLE "provider_symbol_mappings" (
  "market" TEXT NOT NULL,
  "canonical_symbol" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_symbol" TEXT NOT NULL,
  "availability" TEXT NOT NULL DEFAULT 'ACTIVE',
  "rule" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "evidence" TEXT,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_symbol_mappings_pkey" PRIMARY KEY ("market", "canonical_symbol", "provider")
);
