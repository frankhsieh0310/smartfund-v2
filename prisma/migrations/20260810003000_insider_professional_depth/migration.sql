CREATE TABLE IF NOT EXISTS "insiders" (
  "id" TEXT PRIMARY KEY,
  "reporting_owner_cik" TEXT,
  "legal_name" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "source" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "insiders_owner_cik_key" ON "insiders"("reporting_owner_cik") WHERE "reporting_owner_cik" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "insider_filings" (
  "id" TEXT PRIMARY KEY,
  "issuer_security_id" TEXT NOT NULL REFERENCES "securities"("id"),
  "issuer_cik" TEXT,
  "accession_number" TEXT NOT NULL UNIQUE,
  "form_type" TEXT NOT NULL,
  "filing_date" DATE NOT NULL,
  "accepted_at" TIMESTAMPTZ,
  "period_of_report" DATE,
  "document_url" TEXT NOT NULL,
  "raw_xml_url" TEXT,
  "raw_archive_path" TEXT,
  "checksum" TEXT,
  "is_amendment" BOOLEAN NOT NULL DEFAULT FALSE,
  "amends_filing_id" TEXT REFERENCES "insider_filings"("id"),
  "version_sequence" INTEGER NOT NULL DEFAULT 1,
  "effective_version" BOOLEAN NOT NULL DEFAULT TRUE,
  "superseded_at" TIMESTAMPTZ,
  "source" TEXT NOT NULL,
  "retrieved_at" TIMESTAMPTZ NOT NULL,
  "verification_status" TEXT NOT NULL,
  "parser_name" TEXT NOT NULL,
  "parser_version" TEXT NOT NULL,
  "disclosure_regime" TEXT NOT NULL DEFAULT 'US_SECTION16',
  "license_status" TEXT NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "insider_filings_security_date_idx" ON "insider_filings"("issuer_security_id", "filing_date");
CREATE INDEX IF NOT EXISTS "insider_filings_form_date_idx" ON "insider_filings"("form_type", "filing_date");

CREATE TABLE IF NOT EXISTS "insider_issuer_relationships" (
  "id" TEXT PRIMARY KEY,
  "insider_id" TEXT NOT NULL REFERENCES "insiders"("id"),
  "security_id" TEXT NOT NULL REFERENCES "securities"("id"),
  "is_director" BOOLEAN NOT NULL DEFAULT FALSE,
  "is_officer" BOOLEAN NOT NULL DEFAULT FALSE,
  "is_ten_percent_owner" BOOLEAN NOT NULL DEFAULT FALSE,
  "is_other" BOOLEAN NOT NULL DEFAULT FALSE,
  "officer_title" TEXT,
  "other_text" TEXT,
  "effective_from" DATE,
  "effective_to" DATE,
  "source" TEXT NOT NULL,
  "filing_id" TEXT NOT NULL REFERENCES "insider_filings"("id"),
  "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("insider_id", "security_id", "filing_id")
);

CREATE TABLE IF NOT EXISTS "insider_filing_footnotes" (
  "filing_id" TEXT NOT NULL REFERENCES "insider_filings"("id") ON DELETE CASCADE,
  "footnote_id" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY("filing_id", "footnote_id")
);

ALTER TABLE "insider_ownership_transactions"
  ADD COLUMN IF NOT EXISTS "canonical_filing_id" TEXT REFERENCES "insider_filings"("id"),
  ADD COLUMN IF NOT EXISTS "insider_id" TEXT REFERENCES "insiders"("id"),
  ADD COLUMN IF NOT EXISTS "security_title" TEXT,
  ADD COLUMN IF NOT EXISTS "acquired_disposed_code" TEXT,
  ADD COLUMN IF NOT EXISTS "direct_indirect_code" TEXT,
  ADD COLUMN IF NOT EXISTS "ownership_nature" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "nature_of_ownership" TEXT,
  ADD COLUMN IF NOT EXISTS "transaction_form_type" TEXT,
  ADD COLUMN IF NOT EXISTS "economic_category" TEXT,
  ADD COLUMN IF NOT EXISTS "transaction_value" DECIMAL(30,6),
  ADD COLUMN IF NOT EXISTS "transaction_sequence" INTEGER,
  ADD COLUMN IF NOT EXISTS "footnote_references" JSONB,
  ADD COLUMN IF NOT EXISTS "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS "source_url" TEXT,
  ADD COLUMN IF NOT EXISTS "retrieved_at" TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS "insider_ownership_canonical_tx_key" ON "insider_ownership_transactions"("canonical_filing_id", "insider_id", "transaction_sequence") WHERE "canonical_filing_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "insider_derivative_transactions" (
  "id" TEXT PRIMARY KEY,
  "filing_id" TEXT NOT NULL REFERENCES "insider_filings"("id"),
  "insider_id" TEXT NOT NULL REFERENCES "insiders"("id"),
  "security_id" TEXT NOT NULL REFERENCES "securities"("id"),
  "derivative_title" TEXT NOT NULL,
  "conversion_or_exercise_price" DECIMAL(30,6),
  "transaction_date" DATE,
  "transaction_code" TEXT,
  "transaction_shares" DECIMAL(30,6),
  "transaction_acquired_disposed_code" TEXT,
  "exercise_date" DATE,
  "expiration_date" DATE,
  "underlying_security_title" TEXT,
  "underlying_shares" DECIMAL(30,6),
  "ownership_after" DECIMAL(30,6),
  "direct_indirect_code" TEXT,
  "ownership_nature" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "nature_of_ownership" TEXT,
  "economic_category" TEXT,
  "transaction_sequence" INTEGER NOT NULL,
  "footnote_references" JSONB,
  "source" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL,
  "retrieved_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("filing_id", "insider_id", "transaction_sequence")
);
CREATE INDEX IF NOT EXISTS "insider_derivative_security_date_idx" ON "insider_derivative_transactions"("security_id", "transaction_date");

CREATE TABLE IF NOT EXISTS "insider_security_ownership_states" (
  "id" TEXT PRIMARY KEY,
  "filing_id" TEXT NOT NULL REFERENCES "insider_filings"("id"),
  "insider_id" TEXT NOT NULL REFERENCES "insiders"("id"),
  "security_id" TEXT NOT NULL REFERENCES "securities"("id"),
  "security_title" TEXT NOT NULL,
  "is_derivative" BOOLEAN NOT NULL,
  "shares_owned" DECIMAL(30,6),
  "direct_indirect_code" TEXT,
  "ownership_nature" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "nature_of_ownership" TEXT,
  "as_of_date" DATE,
  "sequence" INTEGER NOT NULL,
  "footnote_references" JSONB,
  "source" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL,
  "retrieved_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("filing_id", "insider_id", "is_derivative", "sequence")
);
CREATE INDEX IF NOT EXISTS "insider_ownership_state_history_idx" ON "insider_security_ownership_states"("insider_id", "security_id", "security_title", "as_of_date");

CREATE TABLE IF NOT EXISTS "insider_coverage_matrix" (
  "security_id" TEXT PRIMARY KEY REFERENCES "securities"("id"),
  "source_status" TEXT NOT NULL,
  "issuer_identity_status" TEXT NOT NULL,
  "issuer_cik" TEXT,
  "filing_count" INTEGER NOT NULL DEFAULT 0,
  "insider_count" INTEGER NOT NULL DEFAULT 0,
  "transaction_count" INTEGER NOT NULL DEFAULT 0,
  "first_filing_date" DATE,
  "latest_filing_date" DATE,
  "role_coverage" DECIMAL(8,4),
  "price_coverage" DECIMAL(8,4),
  "ownership_coverage" DECIMAL(8,4),
  "footnote_coverage" DECIMAL(8,4),
  "amendment_status" TEXT NOT NULL DEFAULT 'NONE_FOUND',
  "historical_status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "provenance_status" TEXT NOT NULL,
  "freshness_status" TEXT NOT NULL,
  "coverage_status" TEXT NOT NULL,
  "checked_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
