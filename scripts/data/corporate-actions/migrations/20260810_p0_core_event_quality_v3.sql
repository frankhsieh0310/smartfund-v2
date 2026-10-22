ALTER TABLE corporate_actions ALTER COLUMN announcement_date DROP NOT NULL;
ALTER TABLE corporate_actions
  ADD COLUMN IF NOT EXISTS other_source_date date,
  ADD COLUMN IF NOT EXISTS announcement_date_state text NOT NULL DEFAULT 'UNVERIFIED_LEGACY_DATE',
  ADD COLUMN IF NOT EXISTS effective_date_state text NOT NULL DEFAULT 'UNVERIFIED_LEGACY_DATE',
  ADD COLUMN IF NOT EXISTS date_semantics jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS semantic_state text NOT NULL DEFAULT 'UNVERIFIED_LEGACY',
  ADD COLUMN IF NOT EXISTS provenance_state text NOT NULL DEFAULT 'UNVERIFIED_LEGACY',
  ADD COLUMN IF NOT EXISTS freshness_state text NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS retrieved_at timestamptz;

UPDATE corporate_actions
SET other_source_date = COALESCE(other_source_date, announcement_date),
    announcement_date = NULL,
    effective_date = NULL,
    announcement_date_state = 'SOURCE_DATE_NOT_ANNOUNCEMENT',
    effective_date_state = 'SOURCE_CONTEXT_DATE_NOT_EFFECTIVE',
    date_semantics = jsonb_build_object(
      'otherSourceDateMeaning', 'SEC_FILING_DATE',
      'sourceContextEndMeaning', 'XBRL_FACT_CONTEXT_END',
      'exDateMissingReason', 'NOT_AVAILABLE_FROM_SEC_XBRL_FACT',
      'recordDateMissingReason', 'NOT_AVAILABLE_FROM_SEC_XBRL_FACT',
      'paymentDateMissingReason', 'NOT_AVAILABLE_FROM_SEC_XBRL_FACT'
    ),
    semantic_state = CASE
      WHEN action_type IN ('CASH_DIVIDEND','SHARE_BUYBACK') THEN 'REJECTED_SEMANTIC_CONFLICT'
      ELSE 'UNVERIFIED_LEGACY'
    END,
    provenance_state = 'PARTIAL_PROVENANCE',
    verification_status = 'PARTIAL_PROVENANCE',
    quality_status = CASE
      WHEN action_type IN ('CASH_DIVIDEND','SHARE_BUYBACK') THEN 'REJECTED_SEMANTIC_CONFLICT'
      ELSE 'SOURCE_LIMITED'
    END,
    freshness_state = 'UNVERIFIED',
    lifecycle_state = 'UNVERIFIED',
    retrieved_at = COALESCE(retrieved_at, updated_at),
    raw_payload_checksum = COALESCE(raw_payload_checksum, md5(source_payload::text)),
    parser_version = 'sec-xbrl-v1-legacy-reconciled'
WHERE source = 'SEC_EDGAR_XBRL';

CREATE INDEX IF NOT EXISTS corporate_actions_semantic_state_idx ON corporate_actions (semantic_state, provenance_state, freshness_state);
