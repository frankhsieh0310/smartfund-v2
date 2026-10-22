ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "actual_link_state" TEXT NOT NULL DEFAULT 'NO_MATCHING_ACTUAL';
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "outcome_state" TEXT NOT NULL DEFAULT 'OUTCOME_NOT_AVAILABLE';
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "freshness_state" TEXT NOT NULL DEFAULT 'HISTORICAL_GUIDANCE';

ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "guidance_source_state" TEXT NOT NULL DEFAULT 'SOURCE_CONSTRAINED';
ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "guidance_history_state" TEXT NOT NULL DEFAULT 'SOURCE_CONSTRAINED';
ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "revision_state" TEXT NOT NULL DEFAULT 'SOURCE_CONSTRAINED';
ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "outcome_state" TEXT NOT NULL DEFAULT 'SOURCE_CONSTRAINED';
ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "analyst_license_state" TEXT NOT NULL DEFAULT 'LICENSE_CONSTRAINED';
ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "consensus_state" TEXT NOT NULL DEFAULT 'NO_LICENSE';
ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "target_price_state" TEXT NOT NULL DEFAULT 'NO_LICENSE';
ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "rating_state" TEXT NOT NULL DEFAULT 'NO_LICENSE';
ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "provenance_state" TEXT NOT NULL DEFAULT 'SOURCE_CONSTRAINED';
ALTER TABLE "analyst_estimate_coverage_matrix" ADD COLUMN IF NOT EXISTS "detail_state" TEXT NOT NULL DEFAULT 'SOURCE_CONSTRAINED_READY';
