-- Minimal production reconciliation for the two ETF holdings models already declared in schema.prisma.
CREATE TABLE "etf_holding_snapshots" (
  "id" uuid NOT NULL,
  "etf_id" text NOT NULL,
  "effective_date" date NOT NULL,
  "report_date" date,
  "publication_date" timestamptz,
  "issuer_id" text,
  "source" text NOT NULL,
  "source_type" text NOT NULL,
  "source_url" text NOT NULL,
  "source_record_id" text,
  "retrieved_at" timestamptz NOT NULL,
  "checksum" text NOT NULL,
  "source_row_count" integer NOT NULL,
  "parsed_row_count" integer NOT NULL,
  "canonical_row_count" integer NOT NULL,
  "verification_status" text NOT NULL,
  "license_status" text NOT NULL,
  "completeness_status" text NOT NULL,
  "quality_status" text NOT NULL,
  "quality_metrics" jsonb,
  "parser_version" text NOT NULL,
  "archive_lineage" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assetId" text,
  CONSTRAINT "etf_holding_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "etf_holding_snapshots_etf_id_fkey" FOREIGN KEY ("etf_id") REFERENCES "etfs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "etf_holding_snapshots_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "etf_holding_snapshots_etf_date_url_checksum_key" ON "etf_holding_snapshots"("etf_id", "effective_date", "source_url", "checksum");
CREATE INDEX "etf_holding_snapshots_etf_date_idx" ON "etf_holding_snapshots"("etf_id", "effective_date");

CREATE TABLE "etf_holdings" (
  "id" uuid NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "etf_id" text NOT NULL,
  "effective_date" date NOT NULL,
  "holding_type" text NOT NULL,
  "security_id" text,
  "holding_name" text NOT NULL,
  "ticker" text,
  "isin" text,
  "cusip" text,
  "sedol" text,
  "figi" text,
  "quantity" numeric(38,10),
  "price" numeric(38,10),
  "market_value" numeric(38,8),
  "weight" numeric(14,8),
  "currency" text,
  "country" text,
  "sector" text,
  "industry" text,
  "asset_class" text,
  "coupon" numeric(14,8),
  "maturity_date" date,
  "credit_rating" text,
  "notional" numeric(38,8),
  "source_row_id" text NOT NULL,
  "verification_status" text NOT NULL,
  "quality_status" text NOT NULL,
  "raw_row" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "etf_holdings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "etf_holdings_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "etf_holding_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "etf_holdings_snapshot_source_row_key" ON "etf_holdings"("snapshot_id", "source_row_id");
CREATE INDEX "etf_holdings_etf_date_idx" ON "etf_holdings"("etf_id", "effective_date");
CREATE INDEX "etf_holdings_security_idx" ON "etf_holdings"("security_id");
CREATE INDEX "etf_holdings_isin_idx" ON "etf_holdings"("isin");
CREATE INDEX "etf_holdings_cusip_idx" ON "etf_holdings"("cusip");
CREATE INDEX "etf_holdings_sedol_idx" ON "etf_holdings"("sedol");

REVOKE ALL ON TABLE "etf_holdings" FROM anon, authenticated;