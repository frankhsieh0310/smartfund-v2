-- Additive new table + RLS + REVOKE only, per the user's standing pre-approval
-- ("依CLAUDE.md加RLS＋REVOKE、只新增表／欄位／索引的DDL，這類不用再問我").
--
-- Mirrors the DRAFT design in docs/specs/technical-screener-reverse-lookup.md ("一之一" section),
-- simplified: that draft proposed dedicated `app_readonly_role`/`tw_purchasable_ingestion_role`
-- database roles, but the draft's own note flagged those as UNKNOWN/unverified to exist in this
-- project's actual role setup. Every other new table this round (e.g. etf_upcoming_exrights) is
-- read/written only via the Postgres service-role connection (Prisma), which bypasses RLS
-- entirely -- no anon/authenticated access is needed, so this follows that same established
-- pattern instead of inventing new roles that were never confirmed to exist.
CREATE TABLE IF NOT EXISTS tw_purchasable_classification (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_type         text NOT NULL CHECK (asset_type IN ('FUND', 'ETF')),
  asset_id           text NOT NULL,
  status             text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('APPROVED', 'NOT_APPROVED', 'UNKNOWN')),
  source             text NOT NULL,
  source_record_ref  text,
  checked_at         timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tw_purchasable_classification_unique UNIQUE (asset_type, asset_id)
);

CREATE INDEX IF NOT EXISTS tw_purchasable_classification_asset_idx
  ON tw_purchasable_classification (asset_type, asset_id);

ALTER TABLE tw_purchasable_classification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tw_purchasable_classification FROM anon, authenticated;
