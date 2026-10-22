ALTER TABLE "analyst_estimate_coverage_matrix"
ADD COLUMN IF NOT EXISTS "freshness_state" TEXT NOT NULL DEFAULT 'SOURCE_CONSTRAINED';
