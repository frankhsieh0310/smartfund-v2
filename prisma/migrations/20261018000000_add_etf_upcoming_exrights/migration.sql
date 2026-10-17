-- DRAFT -- NOT applied to any database. Awaiting explicit user approval (new table, needs
-- approval per CLAUDE.md's DDL rule) before being executed against production.
--
-- Mirrors the Prisma model `EtfUpcomingExRight` added to prisma/schema.prisma this round.
-- Deliberately a SEPARATE table from `etf_distribution_events` -- see that model's own doc
-- comment in schema.prisma for why (that table is already read for trailing-yield calculations
-- via "most recent ex_date", and this table's rows are officially-announced but NOT YET PAID,
-- so mixing them in would corrupt an already-verified feature, item 7).

CREATE TABLE IF NOT EXISTS etf_upcoming_exrights (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  etf_id           uuid NOT NULL REFERENCES etfs(id) ON DELETE CASCADE,
  ex_date          date NOT NULL,
  kind             text NOT NULL,
  cash_dividend    numeric(24,10),
  source           text NOT NULL,
  source_record_id text NOT NULL,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT etf_upcoming_exrights_unique UNIQUE (etf_id, ex_date, source)
);

CREATE INDEX IF NOT EXISTS etf_upcoming_exrights_etf_id_ex_date_idx
  ON etf_upcoming_exrights (etf_id, ex_date);

-- Supabase auto-exposes new public-schema tables to anon/authenticated. Per CLAUDE.md's
-- "Supabase RLS" rule, every new table must close that in the same change:
ALTER TABLE etf_upcoming_exrights ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON etf_upcoming_exrights FROM anon, authenticated;

-- No CREATE POLICY: written/read only by server-side code using the Postgres service-role
-- connection (Prisma via DATABASE_URL/DIRECT_URL), which bypasses RLS entirely. No anon/
-- authenticated access needed -- the App reads this data through the existing alert-evaluate
-- cron and Next.js API routes (service-role DB access), never directly from Supabase client-side.
