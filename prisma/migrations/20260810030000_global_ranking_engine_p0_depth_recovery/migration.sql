CREATE TABLE "ranking_metric_contracts" (
  "id" TEXT NOT NULL, "metric_code" TEXT NOT NULL, "asset_type" TEXT NOT NULL,
  "value_semantic" TEXT NOT NULL, "unit" TEXT NOT NULL, "period" TEXT,
  "return_type" TEXT, "currency_semantic" TEXT NOT NULL, "adjustment_semantic" TEXT NOT NULL,
  "source_type" TEXT NOT NULL, "higher_is_better" BOOLEAN NOT NULL,
  "null_policy" TEXT NOT NULL DEFAULT 'EXCLUDE', "eligibility_rule" JSONB NOT NULL,
  "metric_version" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "ranking_metric_contracts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ranking_metric_contracts_asset_type_metric_code_metric_version_key" ON "ranking_metric_contracts"("asset_type", "metric_code", "metric_version");

CREATE TABLE "ranking_definitions" (
  "id" TEXT NOT NULL, "ranking_code" TEXT NOT NULL, "name" TEXT NOT NULL,
  "asset_type" TEXT NOT NULL, "metric_code" TEXT NOT NULL, "metric_contract_id" TEXT NOT NULL,
  "direction" TEXT NOT NULL, "period" TEXT, "universe_type" TEXT NOT NULL,
  "currency_policy" TEXT NOT NULL, "minimum_coverage" DECIMAL(7,4) NOT NULL,
  "minimum_history_days" INTEGER, "minimum_ranked_entities" INTEGER NOT NULL DEFAULT 10,
  "eligibility_rule_version" TEXT NOT NULL, "metric_version" TEXT NOT NULL,
  "definition_status" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ranking_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ranking_definitions_metric_contract_id_fkey" FOREIGN KEY ("metric_contract_id") REFERENCES "ranking_metric_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ranking_definitions_ranking_code_key" ON "ranking_definitions"("ranking_code");
CREATE INDEX "ranking_definitions_asset_type_definition_status_idx" ON "ranking_definitions"("asset_type", "definition_status");

CREATE TABLE "ranking_universe_snapshots" (
  "id" TEXT NOT NULL, "ranking_id" TEXT NOT NULL, "as_of_date" DATE NOT NULL,
  "universe_version" TEXT NOT NULL, "total_canonical_entities" INTEGER NOT NULL,
  "eligible_count" INTEGER NOT NULL, "excluded_count" INTEGER NOT NULL, "ranked_count" INTEGER NOT NULL,
  "coverage_percent" DECIMAL(7,4) NOT NULL, "exclusion_summary" JSONB NOT NULL,
  "freshness_status" TEXT NOT NULL, "source_watermark" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ranking_universe_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ranking_universe_snapshots_ranking_id_fkey" FOREIGN KEY ("ranking_id") REFERENCES "ranking_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ranking_universe_snapshots_ranking_id_as_of_date_universe_version_key" ON "ranking_universe_snapshots"("ranking_id", "as_of_date", "universe_version");
CREATE INDEX "ranking_universe_snapshots_ranking_id_as_of_date_idx" ON "ranking_universe_snapshots"("ranking_id", "as_of_date");

CREATE TABLE "ranking_snapshots" (
  "id" TEXT NOT NULL, "ranking_id" TEXT NOT NULL, "as_of_date" DATE NOT NULL,
  "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "universe_snapshot_id" TEXT NOT NULL,
  "universe_version" TEXT NOT NULL, "metric_version" TEXT NOT NULL, "eligibility_rule_version" TEXT NOT NULL,
  "percentile_method_version" TEXT NOT NULL DEFAULT 'PERCENT_RANK_V1', "tie_method" TEXT NOT NULL DEFAULT 'DENSE_RANK',
  "status" TEXT NOT NULL, "quality_status" TEXT NOT NULL, "freshness_status" TEXT NOT NULL,
  "provenance_coverage" DECIMAL(7,4) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ranking_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ranking_snapshots_ranking_id_fkey" FOREIGN KEY ("ranking_id") REFERENCES "ranking_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ranking_snapshots_universe_snapshot_id_fkey" FOREIGN KEY ("universe_snapshot_id") REFERENCES "ranking_universe_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ranking_snapshots_ranking_id_as_of_date_metric_version_eligibility_rule_version_universe_version_key" ON "ranking_snapshots"("ranking_id", "as_of_date", "metric_version", "eligibility_rule_version", "universe_version");
CREATE INDEX "ranking_snapshots_ranking_id_as_of_date_quality_status_idx" ON "ranking_snapshots"("ranking_id", "as_of_date", "quality_status");

CREATE TABLE "ranking_results" (
  "id" TEXT NOT NULL, "ranking_snapshot_id" TEXT NOT NULL, "asset_type" TEXT NOT NULL,
  "canonical_entity_id" TEXT NOT NULL, "rank" INTEGER NOT NULL, "percentile" DECIMAL(7,4) NOT NULL,
  "metric_value" DECIMAL(38,12) NOT NULL, "metric_unit" TEXT NOT NULL, "metric_as_of_date" DATE NOT NULL,
  "currency" TEXT, "period" TEXT, "source_freshness" TEXT NOT NULL,
  "source_relation" TEXT NOT NULL, "source_record_id" TEXT, "tie_group" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ranking_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ranking_results_ranking_snapshot_id_fkey" FOREIGN KEY ("ranking_snapshot_id") REFERENCES "ranking_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ranking_results_ranking_snapshot_id_asset_type_canonical_entity_id_key" ON "ranking_results"("ranking_snapshot_id", "asset_type", "canonical_entity_id");
CREATE INDEX "ranking_results_ranking_snapshot_id_rank_idx" ON "ranking_results"("ranking_snapshot_id", "rank");
CREATE INDEX "ranking_results_asset_type_canonical_entity_id_idx" ON "ranking_results"("asset_type", "canonical_entity_id");

CREATE TABLE "ranking_work_items" (
  "id" TEXT NOT NULL, "ranking_id" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "upstream_asset" TEXT NOT NULL, "upstream_watermark" TEXT NOT NULL, "dedupe_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3), "last_error" TEXT,
  CONSTRAINT "ranking_work_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ranking_work_items_ranking_id_fkey" FOREIGN KEY ("ranking_id") REFERENCES "ranking_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ranking_work_items_dedupe_key_key" ON "ranking_work_items"("dedupe_key");
CREATE INDEX "ranking_work_items_status_created_at_idx" ON "ranking_work_items"("status", "created_at");
