CREATE TABLE IF NOT EXISTS "sovereign_debt_comparability" (
  "id" TEXT PRIMARY KEY,
  "left_series_id" TEXT NOT NULL,
  "right_series_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "evaluated_at" TIMESTAMP(3) NOT NULL,
  "contract_version" TEXT NOT NULL,
  UNIQUE ("left_series_id", "right_series_id", "contract_version")
);
CREATE INDEX IF NOT EXISTS "sovereign_debt_comparability_status_idx" ON "sovereign_debt_comparability"("status");
