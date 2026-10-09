CREATE TABLE "dataset_registry" (
    "dataset_key" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL,
    "dataset_name" TEXT NOT NULL,
    "master_entity_type" TEXT NOT NULL,
    "target_mode" TEXT NOT NULL,
    "new_assets_auto_included" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "source_provider" TEXT NOT NULL,
    "update_mode" TEXT NOT NULL,
    "expected_frequency" TEXT NOT NULL,
    "freshness_policy" JSONB NOT NULL,
    "freshness_grace_seconds" INTEGER,
    "target_universe_source" TEXT NOT NULL,
    "worker_name" TEXT,
    "checkpoint_reference" TEXT,
    "runtime_status_reference" TEXT,
    "canonical_reference" TEXT NOT NULL,
    "raw_staging_reference" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "is_incremental" BOOLEAN NOT NULL DEFAULT true,
    "is_backfill" BOOLEAN NOT NULL DEFAULT false,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dataset_registry_pkey" PRIMARY KEY ("dataset_key")
);

CREATE TABLE "dataset_runtime_observations" (
    "id" UUID NOT NULL,
    "dataset_key" TEXT NOT NULL,
    "runtime_state" TEXT NOT NULL,
    "pid" INTEGER,
    "heartbeat_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "checkpoint_at" TIMESTAMP(3),
    "checkpoint_cursor" TEXT,
    "last_error" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "execution_success" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "source_success" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "raw_write_success" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "canonical_write_success" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "validation_success" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "data_current" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "pending_count" INTEGER,
    "worker_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    CONSTRAINT "dataset_runtime_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dataset_runtime_observations_dataset_key_fkey" FOREIGN KEY ("dataset_key") REFERENCES "dataset_registry"("dataset_key") ON DELETE CASCADE
);

CREATE TABLE "dataset_coverage_observations" (
    "id" UUID NOT NULL,
    "dataset_key" TEXT NOT NULL,
    "master_count" INTEGER,
    "target_count" INTEGER,
    "ever_success_count" INTEGER,
    "current_count" INTEGER,
    "stale_count" INTEGER,
    "never_synced_count" INTEGER,
    "outside_scope_count" INTEGER,
    "latest_observation_at" TIMESTAMP(3),
    "last_canonical_write_at" TIMESTAMP(3),
    "coverage_percent" DECIMAL(7,4),
    "current_percent" DECIMAL(7,4),
    "raw_latest_at" TIMESTAMP(3),
    "raw_rows" BIGINT,
    "canonical_latest_at" TIMESTAMP(3),
    "canonical_rows" BIGINT,
    "promotion_lag_seconds" BIGINT,
    "raw_layer_status" TEXT NOT NULL DEFAULT 'RAW_LAYER_NOT_AVAILABLE',
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    CONSTRAINT "dataset_coverage_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dataset_coverage_observations_dataset_key_fkey" FOREIGN KEY ("dataset_key") REFERENCES "dataset_registry"("dataset_key") ON DELETE CASCADE
);

CREATE TABLE "dataset_health_states" (
    "dataset_key" TEXT NOT NULL,
    "health_state" TEXT NOT NULL,
    "reason_codes" JSONB NOT NULL,
    "runtime_observation_id" UUID,
    "coverage_observation_id" UUID,
    "condition_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dataset_health_states_pkey" PRIMARY KEY ("dataset_key"),
    CONSTRAINT "dataset_health_states_dataset_key_fkey" FOREIGN KEY ("dataset_key") REFERENCES "dataset_registry"("dataset_key") ON DELETE CASCADE,
    CONSTRAINT "dataset_health_states_runtime_observation_id_fkey" FOREIGN KEY ("runtime_observation_id") REFERENCES "dataset_runtime_observations"("id") ON DELETE SET NULL,
    CONSTRAINT "dataset_health_states_coverage_observation_id_fkey" FOREIGN KEY ("coverage_observation_id") REFERENCES "dataset_coverage_observations"("id") ON DELETE SET NULL
);

CREATE TABLE "dataset_alert_events" (
    "id" UUID NOT NULL,
    "dataset_key" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "severity" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "first_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "details" JSONB,
    CONSTRAINT "dataset_alert_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dataset_alert_events_dataset_key_fkey" FOREIGN KEY ("dataset_key") REFERENCES "dataset_registry"("dataset_key") ON DELETE CASCADE
);

CREATE INDEX "dataset_registry_asset_type_enabled_idx" ON "dataset_registry"("asset_type", "is_enabled");
CREATE INDEX "dataset_runtime_observations_dataset_key_observed_idx" ON "dataset_runtime_observations"("dataset_key", "worker_observed_at" DESC);
CREATE INDEX "dataset_coverage_observations_dataset_key_observed_idx" ON "dataset_coverage_observations"("dataset_key", "observed_at" DESC);
CREATE INDEX "dataset_health_states_health_state_idx" ON "dataset_health_states"("health_state", "evaluated_at");
CREATE INDEX "dataset_alert_events_status_condition_idx" ON "dataset_alert_events"("status", "condition", "last_observed_at");
CREATE UNIQUE INDEX "dataset_alert_events_open_dedupe_key" ON "dataset_alert_events"("dedupe_key") WHERE "status" = 'OPEN';
