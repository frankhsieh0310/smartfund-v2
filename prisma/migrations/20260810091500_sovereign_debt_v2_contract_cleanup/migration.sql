UPDATE "sovereign_debt_observations"
SET "frequency" = 'MONTHLY', "updated_at" = CURRENT_TIMESTAMP
WHERE "series_id" IN ('us-total-public-debt','us-debt-held-public','us-intragov')
  AND "frequency" = 'DAILY';
