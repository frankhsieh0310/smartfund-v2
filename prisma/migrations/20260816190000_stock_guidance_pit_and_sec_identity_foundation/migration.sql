ALTER TABLE "company_guidance"
  ADD COLUMN "known_at" TIMESTAMPTZ,
  ADD COLUMN "effective_as_of" TIMESTAMPTZ,
  ADD COLUMN "known_at_precision" TEXT,
  ADD COLUMN "pit_evidence_status" TEXT NOT NULL DEFAULT 'PIT_EVIDENCE_INCOMPLETE';

CREATE INDEX "company_guidance_stock_id_known_at_idx"
  ON "company_guidance"("stock_id", "known_at");

CREATE TABLE "canonical_issuer_identifiers" (
  "id" UUID NOT NULL,
  "identifier_type" TEXT NOT NULL,
  "identifier_value" TEXT NOT NULL,
  "legal_name" TEXT NOT NULL,
  "jurisdiction" TEXT,
  "source" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL,
  "first_confirmed_at" TIMESTAMPTZ NOT NULL,
  "last_confirmed_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "canonical_issuer_identifiers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_issuer_identifiers_type_value_key" UNIQUE ("identifier_type", "identifier_value")
);

CREATE INDEX "canonical_issuer_identifiers_legal_name_idx"
  ON "canonical_issuer_identifiers"("legal_name");

CREATE TABLE "canonical_issuer_stock_links" (
  "id" UUID NOT NULL,
  "issuer_identifier_id" UUID NOT NULL,
  "stock_id" TEXT NOT NULL,
  "security_id" TEXT,
  "ticker" TEXT NOT NULL,
  "exchange" TEXT NOT NULL,
  "mapping_source" TEXT NOT NULL,
  "source_reference" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL,
  "effective_from" TIMESTAMPTZ,
  "effective_to" TIMESTAMPTZ,
  "first_confirmed_at" TIMESTAMPTZ NOT NULL,
  "last_confirmed_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "canonical_issuer_stock_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_issuer_stock_links_issuer_stock_source_key" UNIQUE ("issuer_identifier_id", "stock_id", "mapping_source"),
  CONSTRAINT "canonical_issuer_stock_links_issuer_fkey" FOREIGN KEY ("issuer_identifier_id") REFERENCES "canonical_issuer_identifiers"("id") ON DELETE CASCADE,
  CONSTRAINT "canonical_issuer_stock_links_stock_fkey" FOREIGN KEY ("stock_id") REFERENCES "stocks"("id") ON DELETE CASCADE,
  CONSTRAINT "canonical_issuer_stock_links_security_fkey" FOREIGN KEY ("security_id") REFERENCES "securities"("id") ON DELETE SET NULL
);

CREATE INDEX "canonical_issuer_stock_links_stock_id_idx" ON "canonical_issuer_stock_links"("stock_id");
CREATE INDEX "canonical_issuer_stock_links_security_id_idx" ON "canonical_issuer_stock_links"("security_id");
