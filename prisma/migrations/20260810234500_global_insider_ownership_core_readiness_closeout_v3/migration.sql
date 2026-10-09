ALTER TABLE proxy_ownership_filings ADD COLUMN IF NOT EXISTS report_context text;
ALTER TABLE proxy_ownership_filings ADD COLUMN IF NOT EXISTS parser_state text NOT NULL DEFAULT 'DISCOVERY_ONLY';
ALTER TABLE proxy_ownership_filings ADD COLUMN IF NOT EXISTS ownership_table_state text NOT NULL DEFAULT 'UNRESOLVED';

ALTER TABLE insider_ownership_snapshots ADD COLUMN IF NOT EXISTS share_class_state text NOT NULL DEFAULT 'UNRESOLVED';
ALTER TABLE insider_ownership_snapshots ADD COLUMN IF NOT EXISTS ownership_percent_state text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_snapshots ADD COLUMN IF NOT EXISTS voting_power_state text NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS share_class_state text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS ownership_percent_state text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS voting_power_state text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS management_state text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS board_state text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS ten_percent_state text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS concentration_state text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS readiness_class text NOT NULL DEFAULT 'NOT_READY';

UPDATE insider_ownership_snapshots SET
  share_class_state=CASE WHEN share_class_id IS NOT NULL THEN 'EXACT_SOURCE_TITLE' ELSE 'UNRESOLVED' END,
  ownership_percent_state=CASE
    WHEN ownership_percent_method='SOURCE_REPORTED_PERCENT' AND ownership_percent IS NOT NULL THEN 'SOURCE_REPORTED_PERCENT'
    WHEN ownership_percent_method='DERIVED_OWNERSHIP_PERCENT' AND ownership_percent IS NOT NULL THEN 'DERIVED_COMPATIBLE_DENOMINATOR'
    ELSE 'DENOMINATOR_CONSTRAINED'
  END,
  voting_power_state=CASE WHEN voting_power_percent IS NOT NULL THEN 'SOURCE_REPORTED_PERCENT' ELSE 'DENOMINATOR_CONSTRAINED' END;
