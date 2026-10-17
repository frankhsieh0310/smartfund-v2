-- Additive new table + RLS + REVOKE only, same pattern/approval as
-- 20261018010000_add_tw_purchasable_classification.
--
-- 2026-10-18 固定範圍第 7 項 (對外數字口徑): every number used in marketing/public-facing copy
-- (e.g. "台積電被 X 檔持有") must record how it was computed -- methodology version, inputs, the
-- resulting number, and when -- so a claimed figure can always be traced back to its real query,
-- not just asserted. Read/written only via the Postgres service-role connection (Prisma), same as
-- every other table added this session; no anon/authenticated access needed.
CREATE TABLE IF NOT EXISTS external_number_audit_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key         text NOT NULL,
  methodology_version text NOT NULL,
  input_params       jsonb NOT NULL,
  result             jsonb NOT NULL,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  computed_by        text NOT NULL,
  notes              text
);

CREATE INDEX IF NOT EXISTS external_number_audit_log_metric_idx
  ON external_number_audit_log (metric_key, computed_at DESC);

ALTER TABLE external_number_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON external_number_audit_log FROM anon, authenticated;
