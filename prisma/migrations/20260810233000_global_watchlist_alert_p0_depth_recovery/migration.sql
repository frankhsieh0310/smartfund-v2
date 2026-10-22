CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "watchlists" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "owner_user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL, "description" TEXT, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "timezone" TEXT, "is_test" BOOLEAN NOT NULL DEFAULT false, "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMP(3), CONSTRAINT "watchlists_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "watchlists_owner_user_id_status_idx" ON "watchlists"("owner_user_id", "status");

CREATE TABLE "watchlist_items" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "watchlist_id" TEXT NOT NULL,
  "asset_type" TEXT NOT NULL, "canonical_asset_id" TEXT NOT NULL, "display_symbol" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "removed_at" TIMESTAMP(3),
  CONSTRAINT "watchlist_items_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "watchlists"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "watchlist_items_active_identity_key" ON "watchlist_items"("watchlist_id", "asset_type", "canonical_asset_id") WHERE "removed_at" IS NULL;
CREATE INDEX "watchlist_items_asset_fanout_idx" ON "watchlist_items"("asset_type", "canonical_asset_id", "status");

CREATE TABLE "watchlist_membership_events" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "watchlist_item_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL, "effective_at" TIMESTAMP(3) NOT NULL, "actor_user_id" TEXT NOT NULL, "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "watchlist_membership_events_item_fkey" FOREIGN KEY ("watchlist_item_id") REFERENCES "watchlist_items"("id") ON DELETE CASCADE,
  CONSTRAINT "watchlist_membership_events_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
CREATE INDEX "watchlist_membership_events_item_effective_idx" ON "watchlist_membership_events"("watchlist_item_id", "effective_at");

CREATE TABLE "alert_rules_p0" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "owner_user_id" TEXT NOT NULL, "watchlist_id" TEXT,
  "watchlist_item_id" TEXT, "asset_type" TEXT NOT NULL, "canonical_asset_id" TEXT,
  "rule_family" TEXT NOT NULL, "rule_kind" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "severity" TEXT NOT NULL DEFAULT 'INFO', "priority" INTEGER, "current_version_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_rules_p0_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "alert_rules_p0_watchlist_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "watchlists"("id") ON DELETE CASCADE,
  CONSTRAINT "alert_rules_p0_item_fkey" FOREIGN KEY ("watchlist_item_id") REFERENCES "watchlist_items"("id") ON DELETE CASCADE
);
CREATE INDEX "alert_rules_p0_fanout_idx" ON "alert_rules_p0"("asset_type", "canonical_asset_id", "status", "rule_family");

CREATE TABLE "alert_rule_versions" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "rule_id" TEXT NOT NULL, "version_number" INTEGER NOT NULL,
  "parameters" JSONB NOT NULL, "effective_from" TIMESTAMP(3) NOT NULL, "effective_to" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL DEFAULT 'VERIFIED',
  CONSTRAINT "alert_rule_versions_rule_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules_p0"("id") ON DELETE CASCADE,
  CONSTRAINT "alert_rule_versions_creator_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "alert_rule_versions_rule_version_key" ON "alert_rule_versions"("rule_id", "version_number");
ALTER TABLE "alert_rules_p0" ADD CONSTRAINT "alert_rules_p0_current_version_fkey" FOREIGN KEY ("current_version_id") REFERENCES "alert_rule_versions"("id") ON DELETE SET NULL;

CREATE TABLE "alert_rule_states" (
  "rule_id" TEXT PRIMARY KEY, "rule_version_id" TEXT NOT NULL, "last_evaluated_at" TIMESTAMP(3),
  "last_observation_id" TEXT, "last_observation_at" TIMESTAMP(3), "last_value" DECIMAL(38,12),
  "current_condition_state" TEXT NOT NULL DEFAULT 'UNKNOWN', "last_triggered_at" TIMESTAMP(3), "last_cleared_at" TIMESTAMP(3),
  "cooldown_until" TIMESTAMP(3), "evaluation_version" TEXT NOT NULL,
  CONSTRAINT "alert_rule_states_rule_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules_p0"("id") ON DELETE CASCADE,
  CONSTRAINT "alert_rule_states_version_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "alert_rule_versions"("id") ON DELETE RESTRICT
);

CREATE TABLE "watchlist_input_sources" (
  "id" TEXT PRIMARY KEY, "asset_type" TEXT NOT NULL, "canonical_service" TEXT NOT NULL,
  "canonical_relation" TEXT NOT NULL, "supported_observation_kinds" JSONB NOT NULL,
  "watermark" TEXT, "freshness_contract" JSONB NOT NULL, "status" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL, "license_status" TEXT NOT NULL DEFAULT 'INHERIT_UPSTREAM',
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "watchlist_input_sources_asset_service_key" ON "watchlist_input_sources"("asset_type", "canonical_service");

CREATE TABLE "alert_evaluation_work_items" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "source_type" TEXT NOT NULL, "upstream_watermark" TEXT NOT NULL,
  "canonical_asset_id" TEXT NOT NULL, "asset_type" TEXT NOT NULL, "observation_id" TEXT, "event_id" TEXT,
  "input_revision_id" TEXT, "dedupe_key" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "replay_mode" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3), "last_error" TEXT
);
CREATE UNIQUE INDEX "alert_evaluation_work_items_dedupe_key_key" ON "alert_evaluation_work_items"("dedupe_key");
CREATE INDEX "alert_evaluation_work_items_status_created_idx" ON "alert_evaluation_work_items"("status", "created_at");

CREATE TABLE "alert_occurrences" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "rule_id" TEXT NOT NULL, "rule_version_id" TEXT NOT NULL,
  "watchlist_id" TEXT, "watchlist_item_id" TEXT, "asset_type" TEXT NOT NULL, "canonical_asset_id" TEXT,
  "triggered_at" TIMESTAMP(3) NOT NULL, "trigger_type" TEXT NOT NULL, "severity" TEXT NOT NULL,
  "observation_id" TEXT, "event_id" TEXT, "input_revision_id" TEXT, "trigger_value" DECIMAL(38,12), "threshold_value" DECIMAL(38,12),
  "payload" JSONB NOT NULL, "source" TEXT NOT NULL, "source_record_id" TEXT, "input_as_of_date" TIMESTAMP(3) NOT NULL,
  "input_observed_at" TIMESTAMP(3) NOT NULL, "evaluation_at" TIMESTAMP(3) NOT NULL, "freshness_status" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL, "dedupe_key" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'TRIGGERED',
  "expires_at" TIMESTAMP(3), "acknowledged_at" TIMESTAMP(3), "acknowledged_by" TEXT, "dismissed_at" TIMESTAMP(3), "dismissed_by" TEXT,
  CONSTRAINT "alert_occurrences_rule_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules_p0"("id") ON DELETE CASCADE,
  CONSTRAINT "alert_occurrences_version_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "alert_rule_versions"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "alert_occurrences_dedupe_key_key" ON "alert_occurrences"("dedupe_key");
CREATE INDEX "alert_occurrences_history_idx" ON "alert_occurrences"("rule_id", "triggered_at");
CREATE INDEX "alert_occurrences_filter_idx" ON "alert_occurrences"("status", "severity", "asset_type", "triggered_at");

CREATE TABLE "alert_occurrence_events" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "alert_occurrence_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL, "event_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "previous_status" TEXT, "new_status" TEXT NOT NULL, "reason" TEXT, "metadata" JSONB,
  CONSTRAINT "alert_occurrence_events_occurrence_fkey" FOREIGN KEY ("alert_occurrence_id") REFERENCES "alert_occurrences"("id") ON DELETE CASCADE
);
CREATE INDEX "alert_occurrence_events_occurrence_time_idx" ON "alert_occurrence_events"("alert_occurrence_id", "event_at");

CREATE TABLE "notification_profiles" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "user_id" TEXT NOT NULL, "channel_type" TEXT NOT NULL,
  "destination_reference" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true, "timezone" TEXT NOT NULL,
  "quiet_hours" JSONB, "severity_threshold" TEXT, "frequency_cap" JSONB, "critical_bypass_policy" TEXT,
  "is_test" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_profiles_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE "alert_delivery_attempts" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "alert_occurrence_id" TEXT NOT NULL, "profile_id" TEXT NOT NULL,
  "channel_type" TEXT NOT NULL, "attempt_number" INTEGER NOT NULL, "attempted_at" TIMESTAMP(3) NOT NULL,
  "delivered_at" TIMESTAMP(3), "status" TEXT NOT NULL, "provider_message_id" TEXT, "failure_code" TEXT, "failure_reason" TEXT,
  "non_user_delivery" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "alert_delivery_attempts_occurrence_fkey" FOREIGN KEY ("alert_occurrence_id") REFERENCES "alert_occurrences"("id") ON DELETE CASCADE,
  CONSTRAINT "alert_delivery_attempts_profile_fkey" FOREIGN KEY ("profile_id") REFERENCES "notification_profiles"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "alert_delivery_attempts_number_key" ON "alert_delivery_attempts"("alert_occurrence_id", "profile_id", "attempt_number");

CREATE TABLE "alert_delivery_dead_letters" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "alert_occurrence_id" TEXT NOT NULL, "profile_id" TEXT NOT NULL,
  "failure_class" TEXT NOT NULL, "attempt_count" INTEGER NOT NULL, "last_failure" JSONB NOT NULL, "next_action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolved_at" TIMESTAMP(3),
  CONSTRAINT "alert_delivery_dead_letters_occurrence_fkey" FOREIGN KEY ("alert_occurrence_id") REFERENCES "alert_occurrences"("id") ON DELETE CASCADE,
  CONSTRAINT "alert_delivery_dead_letters_profile_fkey" FOREIGN KEY ("profile_id") REFERENCES "notification_profiles"("id") ON DELETE RESTRICT
);

INSERT INTO "watchlist_input_sources" ("id","asset_type","canonical_service","canonical_relation","supported_observation_kinds","freshness_contract","status","verification_status") VALUES
('stock-history','STOCK','CANONICAL_STOCK','stock_history','["PRICE","VOLUME"]','{"watermark":"updated_at_or_date","calendar":"TRADING"}','READY_PENDING_CONNECTIVITY','SCHEMA_VERIFIED'),
('etf-history','ETF','CANONICAL_ETF','etf_history','["PRICE","NAV","VOLUME"]','{"watermark":"created_at_or_date","calendar":"TRADING"}','READY_PENDING_CONNECTIVITY','SCHEMA_VERIFIED'),
('fund-history','FUND','CANONICAL_FUND','fund_history','["NAV","AUM"]','{"watermark":"created_at_or_date","calendar":"FUND_NAV"}','READY_PENDING_CONNECTIVITY','SCHEMA_VERIFIED'),
('market-data-index','INDEX','CANONICAL_MARKET_DATA','market_data','["INDEX_LEVEL","VOLUME"]','{"watermark":"created_at_or_date","calendar":"TRADING"}','READY_PENDING_CONNECTIVITY','SCHEMA_VERIFIED'),
('market-data-fx','FX','CANONICAL_MARKET_DATA','market_data','["PRICE"]','{"watermark":"created_at_or_date","calendar":"FX"}','READY_PENDING_CONNECTIVITY','SCHEMA_VERIFIED'),
('crypto-candles','CRYPTO','CANONICAL_CRYPTO','crypto_candles','["PRICE","VOLUME"]','{"watermark":"updated_at","calendar":"24_7"}','READY_PENDING_CONNECTIVITY','SCHEMA_VERIFIED');
