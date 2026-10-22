ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "parser_version" TEXT NOT NULL DEFAULT 'GUIDANCE_PARSER_V2';
ALTER TABLE "company_guidance_revisions" ADD COLUMN IF NOT EXISTS "previous_low" DECIMAL(30,8);
ALTER TABLE "company_guidance_revisions" ADD COLUMN IF NOT EXISTS "previous_high" DECIMAL(30,8);
ALTER TABLE "company_guidance_revisions" ADD COLUMN IF NOT EXISTS "current_low" DECIMAL(30,8);
ALTER TABLE "company_guidance_revisions" ADD COLUMN IF NOT EXISTS "current_high" DECIMAL(30,8);
ALTER TABLE "company_guidance_revisions" ADD COLUMN IF NOT EXISTS "lower_change" DECIMAL(30,8);
ALTER TABLE "company_guidance_revisions" ADD COLUMN IF NOT EXISTS "upper_change" DECIMAL(30,8);
ALTER TABLE "company_guidance_revisions" ADD COLUMN IF NOT EXISTS "midpoint_change" DECIMAL(30,8);
ALTER TABLE "company_guidance_revisions" ADD COLUMN IF NOT EXISTS "formula_version" TEXT NOT NULL DEFAULT 'GUIDANCE_REVISION_V2';
ALTER TABLE "company_guidance_revisions" ADD COLUMN IF NOT EXISTS "source_evidence" TEXT;

CREATE TABLE IF NOT EXISTS "company_guidance_actual_links" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "guidance_id" UUID NOT NULL UNIQUE REFERENCES "company_guidance"("id") ON DELETE CASCADE,
  "actual_source_fact_key" TEXT NOT NULL,
  "actual_metric" TEXT NOT NULL,
  "actual_period_end" DATE NOT NULL,
  "actual_value" DECIMAL(30,8) NOT NULL,
  "actual_value_normalized" DECIMAL(30,8) NOT NULL,
  "actual_unit" TEXT NOT NULL,
  "actual_currency" TEXT,
  "compatibility_status" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL,
  "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "company_guidance_outcomes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "guidance_id" UUID NOT NULL UNIQUE REFERENCES "company_guidance"("id") ON DELETE CASCADE,
  "actual_link_id" UUID NOT NULL UNIQUE REFERENCES "company_guidance_actual_links"("id") ON DELETE CASCADE,
  "actual_value" DECIMAL(30,8) NOT NULL,
  "difference_from_low" DECIMAL(30,8),
  "difference_from_high" DECIMAL(30,8),
  "difference_from_mid" DECIMAL(30,8),
  "outcome" TEXT NOT NULL,
  "analytic_type" TEXT NOT NULL DEFAULT 'DERIVED_ANALYTIC',
  "formula_version" TEXT NOT NULL DEFAULT 'GUIDANCE_OUTCOME_V1',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
