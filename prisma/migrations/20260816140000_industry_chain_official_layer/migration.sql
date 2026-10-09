CREATE TABLE "industry_chain_industries" (
  "id" TEXT PRIMARY KEY, "canonical_name" TEXT NOT NULL, "source" TEXT NOT NULL,
  "source_identifier" TEXT NOT NULL, "source_reference" TEXT NOT NULL,
  "retrieved_at" TIMESTAMP(3) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "industry_chain_industries_source_source_identifier_key" UNIQUE ("source", "source_identifier")
);
CREATE TABLE "industry_chain_nodes" (
  "id" TEXT PRIMARY KEY, "industry_id" TEXT NOT NULL, "parent_id" TEXT,
  "canonical_name" TEXT NOT NULL, "hierarchy_level" TEXT NOT NULL, "chain_stage" TEXT NOT NULL,
  "source_identifier" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "industry_chain_nodes_industry_id_fkey" FOREIGN KEY ("industry_id") REFERENCES "industry_chain_industries"("id") ON DELETE CASCADE,
  CONSTRAINT "industry_chain_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "industry_chain_nodes"("id"),
  CONSTRAINT "industry_chain_nodes_industry_id_source_identifier_key" UNIQUE ("industry_id", "source_identifier")
);
CREATE INDEX "industry_chain_nodes_industry_id_chain_stage_idx" ON "industry_chain_nodes"("industry_id", "chain_stage");
CREATE TABLE "industry_chain_memberships" (
  "id" TEXT PRIMARY KEY, "industry_node_id" TEXT NOT NULL, "stock_id" TEXT,
  "company_name" TEXT NOT NULL, "official_ticker" TEXT, "official_reference" TEXT NOT NULL,
  "market_category" TEXT, "mapping_status" TEXT NOT NULL, "source_key" TEXT NOT NULL UNIQUE,
  "active" BOOLEAN NOT NULL DEFAULT TRUE, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "industry_chain_memberships_industry_node_id_fkey" FOREIGN KEY ("industry_node_id") REFERENCES "industry_chain_nodes"("id") ON DELETE CASCADE
);
CREATE INDEX "industry_chain_memberships_stock_id_active_idx" ON "industry_chain_memberships"("stock_id", "active");
CREATE INDEX "industry_chain_memberships_official_ticker_idx" ON "industry_chain_memberships"("official_ticker");
CREATE TABLE "industry_chain_evidence" (
  "id" TEXT PRIMARY KEY, "membership_id" TEXT NOT NULL, "source" TEXT NOT NULL,
  "source_reference" TEXT NOT NULL, "source_identifier" TEXT NOT NULL,
  "first_confirmed" TIMESTAMP(3), "last_confirmed" TIMESTAMP(3), "retrieved_at" TIMESTAMP(3) NOT NULL,
  "verified_at" TIMESTAMP(3), "verification_status" TEXT NOT NULL, "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "industry_chain_evidence_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "industry_chain_memberships"("id") ON DELETE CASCADE,
  CONSTRAINT "industry_chain_evidence_membership_source_identifier_key" UNIQUE ("membership_id", "source", "source_identifier")
);
CREATE TABLE "industry_chain_import_checkpoints" (
  "source" TEXT PRIMARY KEY, "discovered_ids" JSONB NOT NULL, "completed_ids" JSONB NOT NULL,
  "current_industry_id" TEXT, "status" TEXT NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT, "started_at" TIMESTAMP(3), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3)
);
