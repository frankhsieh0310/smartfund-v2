ALTER TABLE share_buyback_programs ADD COLUMN IF NOT EXISTS semantic_origin text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE share_buyback_programs ADD COLUMN IF NOT EXISTS authorization_evidence jsonb;
ALTER TABLE share_buyback_programs ADD COLUMN IF NOT EXISTS board_approval_date date;
ALTER TABLE share_buyback_programs ADD COLUMN IF NOT EXISTS parser_version text;
ALTER TABLE share_buyback_programs ADD COLUMN IF NOT EXISTS source_checksum text;
ALTER TABLE share_buyback_executions ALTER COLUMN program_id DROP NOT NULL;
ALTER TABLE share_buyback_executions ADD COLUMN IF NOT EXISTS linkage_status text NOT NULL DEFAULT 'UNRESOLVED';
ALTER TABLE share_buyback_executions ADD COLUMN IF NOT EXISTS parser_version text;
ALTER TABLE share_buyback_executions ADD COLUMN IF NOT EXISTS source_checksum text;
UPDATE share_buyback_executions e SET program_id=NULL, linkage_status='UNRESOLVED'
WHERE EXISTS (SELECT 1 FROM share_buyback_programs p WHERE p.id=e.program_id AND p.program_key LIKE 'EXECUTION_DISCLOSURE:%');
DELETE FROM share_buyback_programs WHERE program_key LIKE 'EXECUTION_DISCLOSURE:%';
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS execution_count integer NOT NULL DEFAULT 0;
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS earliest_execution_date date;
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS latest_execution_date date;
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS detail_readiness text NOT NULL DEFAULT 'NOT_READY';
ALTER TABLE share_buyback_program_coverage ADD COLUMN IF NOT EXISTS execution_linkage_status text NOT NULL DEFAULT 'UNRESOLVED';
ALTER TABLE share_buyback_program_coverage ADD COLUMN IF NOT EXISTS authorization_evidence_status text NOT NULL DEFAULT 'MISSING';
CREATE TABLE IF NOT EXISTS share_buyback_analytics (
  security_id text NOT NULL REFERENCES securities(id), metric text NOT NULL, as_of_date date NOT NULL,
  value numeric(30,10), currency text, window_start date, window_end date,
  source_execution_count integer NOT NULL DEFAULT 0, formula_version text NOT NULL,
  input_status text NOT NULL, source_type text NOT NULL DEFAULT 'DERIVED_ANALYTIC',
  calculated_at timestamptz NOT NULL, PRIMARY KEY(security_id,metric,as_of_date)
);
CREATE INDEX IF NOT EXISTS share_buyback_analytics_metric_date_idx ON share_buyback_analytics(metric,as_of_date);
