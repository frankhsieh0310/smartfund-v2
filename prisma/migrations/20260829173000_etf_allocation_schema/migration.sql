CREATE TABLE "etf_sector_allocations" (
  "id" uuid NOT NULL,
  "etf_id" text NOT NULL,
  "observation_date" date NOT NULL,
  "sector_name" text NOT NULL,
  "weight" numeric(14,8) NOT NULL,
  "source" text NOT NULL,
  "source_url" text,
  "retrieved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "etf_sector_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "etf_sector_allocations_etf_id_fkey" FOREIGN KEY ("etf_id") REFERENCES "etfs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "etf_sector_allocations_weight_check" CHECK ("weight" >= 0 AND "weight" <= 1)
);
CREATE UNIQUE INDEX "etf_sector_allocations_identity_key" ON "etf_sector_allocations"("etf_id", "observation_date", "source", "sector_name");
CREATE INDEX "etf_sector_allocations_etf_date_idx" ON "etf_sector_allocations"("etf_id", "observation_date");

CREATE TABLE "etf_credit_rating_allocations" (
  "id" uuid NOT NULL,
  "etf_id" text NOT NULL,
  "observation_date" date NOT NULL,
  "credit_rating" text NOT NULL,
  "weight" numeric(14,8) NOT NULL,
  "source" text NOT NULL,
  "source_url" text,
  "retrieved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "etf_credit_rating_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "etf_credit_rating_allocations_etf_id_fkey" FOREIGN KEY ("etf_id") REFERENCES "etfs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "etf_credit_rating_allocations_weight_check" CHECK ("weight" >= 0 AND "weight" <= 1)
);
CREATE UNIQUE INDEX "etf_credit_rating_allocations_identity_key" ON "etf_credit_rating_allocations"("etf_id", "observation_date", "source", "credit_rating");
CREATE INDEX "etf_credit_rating_allocations_etf_date_idx" ON "etf_credit_rating_allocations"("etf_id", "observation_date");