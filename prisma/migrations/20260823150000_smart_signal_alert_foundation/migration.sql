CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "alert_rules_p0" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "owner_user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "watchlist_id" TEXT REFERENCES "watchlists"("id") ON DELETE CASCADE, "watchlist_item_id" TEXT REFERENCES "watchlist_items"("id") ON DELETE CASCADE,
  "asset_type" TEXT NOT NULL, "canonical_asset_id" TEXT, "rule_family" TEXT NOT NULL, "rule_kind" TEXT NOT NULL,
  "scope_type" TEXT NOT NULL DEFAULT 'SINGLE_ASSET', "logical_operator" TEXT NOT NULL DEFAULT 'AND', "frequency" TEXT NOT NULL DEFAULT 'RECURRING',
  "cadence" TEXT NOT NULL DEFAULT 'DAILY', "cooldown_seconds" INTEGER NOT NULL DEFAULT 0, "delivery_channels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "expires_at" TIMESTAMP(3), "status" TEXT NOT NULL DEFAULT 'ACTIVE', "severity" TEXT NOT NULL DEFAULT 'INFO', "priority" INTEGER,
  "current_version_id" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "alert_rules_p0_owner_status_idx" ON "alert_rules_p0"("owner_user_id","status","created_at");
CREATE INDEX IF NOT EXISTS "alert_rules_p0_fanout_idx" ON "alert_rules_p0"("asset_type","canonical_asset_id","status","rule_family");

CREATE TABLE IF NOT EXISTS "alert_rule_versions" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "rule_id" TEXT NOT NULL REFERENCES "alert_rules_p0"("id") ON DELETE CASCADE,
  "version_number" INTEGER NOT NULL, "parameters" JSONB NOT NULL, "effective_from" TIMESTAMP(3) NOT NULL,
  "effective_to" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT, "verification_status" TEXT NOT NULL DEFAULT 'VERIFIED',
  UNIQUE("rule_id","version_number")
);
ALTER TABLE "alert_rules_p0" DROP CONSTRAINT IF EXISTS "alert_rules_p0_current_version_fkey";
ALTER TABLE "alert_rules_p0" ADD CONSTRAINT "alert_rules_p0_current_version_fkey" FOREIGN KEY("current_version_id") REFERENCES "alert_rule_versions"("id") ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS "alert_rule_states" (
  "rule_id" TEXT PRIMARY KEY REFERENCES "alert_rules_p0"("id") ON DELETE CASCADE, "rule_version_id" TEXT NOT NULL REFERENCES "alert_rule_versions"("id") ON DELETE RESTRICT,
  "last_evaluated_at" TIMESTAMP(3), "last_observation_id" TEXT, "last_observation_at" TIMESTAMP(3), "last_value" DECIMAL(38,12),
  "current_condition_state" TEXT NOT NULL DEFAULT 'UNKNOWN', "last_triggered_at" TIMESTAMP(3), "last_cleared_at" TIMESTAMP(3),
  "cooldown_until" TIMESTAMP(3), "evaluation_version" TEXT NOT NULL, "next_evaluation_at" TIMESTAMP(3),
  "trigger_count" INTEGER NOT NULL DEFAULT 0, "last_error" TEXT, "data_availability" TEXT NOT NULL DEFAULT 'NOT_AVAILABLE'
);

CREATE TABLE IF NOT EXISTS "alert_evaluation_work_items" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "source_type" TEXT NOT NULL, "upstream_watermark" TEXT NOT NULL,
  "canonical_asset_id" TEXT NOT NULL, "asset_type" TEXT NOT NULL, "observation_id" TEXT, "event_id" TEXT, "input_revision_id" TEXT,
  "dedupe_key" TEXT NOT NULL UNIQUE, "status" TEXT NOT NULL DEFAULT 'PENDING', "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "replay_mode" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3), "last_error" TEXT
);
CREATE INDEX IF NOT EXISTS "alert_evaluation_work_items_status_created_idx" ON "alert_evaluation_work_items"("status","created_at");

CREATE TABLE IF NOT EXISTS "alert_occurrences" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "rule_id" TEXT NOT NULL REFERENCES "alert_rules_p0"("id") ON DELETE CASCADE,
  "rule_version_id" TEXT NOT NULL REFERENCES "alert_rule_versions"("id") ON DELETE RESTRICT, "watchlist_id" TEXT, "watchlist_item_id" TEXT,
  "asset_type" TEXT NOT NULL, "canonical_asset_id" TEXT, "triggered_at" TIMESTAMP(3) NOT NULL, "trigger_type" TEXT NOT NULL,
  "severity" TEXT NOT NULL, "observation_id" TEXT, "event_id" TEXT, "input_revision_id" TEXT, "trigger_value" DECIMAL(38,12),
  "threshold_value" DECIMAL(38,12), "payload" JSONB NOT NULL, "source" TEXT NOT NULL, "source_record_id" TEXT,
  "input_as_of_date" TIMESTAMP(3) NOT NULL, "input_observed_at" TIMESTAMP(3) NOT NULL, "evaluation_at" TIMESTAMP(3) NOT NULL,
  "freshness_status" TEXT NOT NULL, "verification_status" TEXT NOT NULL, "dedupe_key" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'TRIGGERED', "expires_at" TIMESTAMP(3), "acknowledged_at" TIMESTAMP(3), "acknowledged_by" TEXT,
  "dismissed_at" TIMESTAMP(3), "dismissed_by" TEXT
);
CREATE INDEX IF NOT EXISTS "alert_occurrences_history_idx" ON "alert_occurrences"("rule_id","triggered_at");

CREATE TABLE IF NOT EXISTS "alert_occurrence_events" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "alert_occurrence_id" TEXT NOT NULL REFERENCES "alert_occurrences"("id") ON DELETE CASCADE,
  "event_type" TEXT NOT NULL, "event_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "previous_status" TEXT,
  "new_status" TEXT NOT NULL, "reason" TEXT, "metadata" JSONB
);
CREATE INDEX IF NOT EXISTS "alert_occurrence_events_occurrence_time_idx" ON "alert_occurrence_events"("alert_occurrence_id","event_at");

CREATE TABLE IF NOT EXISTS "notification_profiles" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "channel_type" TEXT NOT NULL, "destination_reference" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "timezone" TEXT NOT NULL, "quiet_hours" JSONB, "severity_threshold" TEXT, "frequency_cap" JSONB,
  "critical_bypass_policy" TEXT, "is_test" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "notification_profiles_user_channel_destination_key" ON "notification_profiles"("user_id","channel_type","destination_reference");

CREATE TABLE IF NOT EXISTS "alert_delivery_attempts" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "alert_occurrence_id" TEXT NOT NULL REFERENCES "alert_occurrences"("id") ON DELETE CASCADE,
  "profile_id" TEXT NOT NULL REFERENCES "notification_profiles"("id") ON DELETE RESTRICT, "channel_type" TEXT NOT NULL,
  "attempt_number" INTEGER NOT NULL, "attempted_at" TIMESTAMP(3) NOT NULL, "delivered_at" TIMESTAMP(3), "status" TEXT NOT NULL,
  "provider_message_id" TEXT, "failure_code" TEXT, "failure_reason" TEXT, "non_user_delivery" BOOLEAN NOT NULL DEFAULT false,
  UNIQUE("alert_occurrence_id","profile_id","attempt_number")
);

CREATE TABLE IF NOT EXISTS "alert_delivery_dead_letters" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, "alert_occurrence_id" TEXT NOT NULL REFERENCES "alert_occurrences"("id") ON DELETE CASCADE,
  "profile_id" TEXT NOT NULL REFERENCES "notification_profiles"("id") ON DELETE RESTRICT, "failure_class" TEXT NOT NULL,
  "attempt_count" INTEGER NOT NULL, "last_failure" JSONB NOT NULL, "next_action" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'OPEN',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolved_at" TIMESTAMP(3)
);

ALTER TABLE "alert_rules_p0" ENABLE ROW LEVEL SECURITY; ALTER TABLE "alert_rule_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_rule_states" ENABLE ROW LEVEL SECURITY; ALTER TABLE "alert_occurrences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_occurrence_events" ENABLE ROW LEVEL SECURITY; ALTER TABLE "notification_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_delivery_attempts" ENABLE ROW LEVEL SECURITY; ALTER TABLE "alert_evaluation_work_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_delivery_dead_letters" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON "alert_rules_p0","alert_rule_versions","alert_rule_states","alert_occurrences","alert_occurrence_events","notification_profiles","alert_delivery_attempts","alert_evaluation_work_items","alert_delivery_dead_letters" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "alert_rules_p0","alert_rule_versions","alert_rule_states","notification_profiles" TO authenticated;
GRANT SELECT ON "alert_occurrences","alert_occurrence_events","alert_delivery_attempts" TO authenticated;

CREATE POLICY "alert_rules_owner_all" ON "alert_rules_p0" FOR ALL TO authenticated USING (EXISTS(SELECT 1 FROM users u WHERE u.id=owner_user_id AND u.supabase_id=(SELECT auth.uid())::text)) WITH CHECK (EXISTS(SELECT 1 FROM users u WHERE u.id=owner_user_id AND u.supabase_id=(SELECT auth.uid())::text));
CREATE POLICY "alert_versions_owner_all" ON "alert_rule_versions" FOR ALL TO authenticated USING (EXISTS(SELECT 1 FROM alert_rules_p0 r JOIN users u ON u.id=r.owner_user_id WHERE r.id=rule_id AND u.supabase_id=(SELECT auth.uid())::text)) WITH CHECK (EXISTS(SELECT 1 FROM alert_rules_p0 r JOIN users u ON u.id=r.owner_user_id WHERE r.id=rule_id AND u.supabase_id=(SELECT auth.uid())::text));
CREATE POLICY "alert_states_owner_all" ON "alert_rule_states" FOR ALL TO authenticated USING (EXISTS(SELECT 1 FROM alert_rules_p0 r JOIN users u ON u.id=r.owner_user_id WHERE r.id=rule_id AND u.supabase_id=(SELECT auth.uid())::text)) WITH CHECK (EXISTS(SELECT 1 FROM alert_rules_p0 r JOIN users u ON u.id=r.owner_user_id WHERE r.id=rule_id AND u.supabase_id=(SELECT auth.uid())::text));
CREATE POLICY "alert_occurrences_owner_select" ON "alert_occurrences" FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM alert_rules_p0 r JOIN users u ON u.id=r.owner_user_id WHERE r.id=rule_id AND u.supabase_id=(SELECT auth.uid())::text));
CREATE POLICY "alert_occurrence_events_owner_select" ON "alert_occurrence_events" FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM alert_occurrences o JOIN alert_rules_p0 r ON r.id=o.rule_id JOIN users u ON u.id=r.owner_user_id WHERE o.id=alert_occurrence_id AND u.supabase_id=(SELECT auth.uid())::text));
CREATE POLICY "notification_profiles_owner_all" ON "notification_profiles" FOR ALL TO authenticated USING (EXISTS(SELECT 1 FROM users u WHERE u.id=user_id AND u.supabase_id=(SELECT auth.uid())::text)) WITH CHECK (EXISTS(SELECT 1 FROM users u WHERE u.id=user_id AND u.supabase_id=(SELECT auth.uid())::text));
CREATE POLICY "alert_delivery_owner_select" ON "alert_delivery_attempts" FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM alert_occurrences o JOIN alert_rules_p0 r ON r.id=o.rule_id JOIN users u ON u.id=r.owner_user_id WHERE o.id=alert_occurrence_id AND u.supabase_id=(SELECT auth.uid())::text));
