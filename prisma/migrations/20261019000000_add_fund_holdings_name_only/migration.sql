-- User-approved, 2026-10-19: new table, per CLAUDE.md's DDL rule (additive new table + RLS +
-- REVOKE, same pre-approved class as 20261018000000_add_etf_upcoming_exrights).
--
-- MoneyDJ's "持股" page has a format that discloses only the top 5/10 holding NAMES, never a
-- weight -- see MoneydjHoldingsNameOnlyError in lib/cloud-ingestion/moneydjFundDisclosure.ts.
-- Deliberately a SEPARATE table from `holdings`, never the same one: `holdings.weight` is
-- NOT NULL, and the user explicitly prohibited fabricating a weight number just to satisfy that
-- constraint. Keeping this data in its own table means nothing downstream can accidentally read
-- it as if it had a real weight -- the absence of a weight column here is the whole point.
--
-- Mirrors the Prisma model `FundHoldingNameOnly` added to prisma/schema.prisma this round.

CREATE TABLE IF NOT EXISTS fund_holdings_name_only (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id      text NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  holding_name text NOT NULL,
  rank         int NOT NULL,
  as_of_date   date NOT NULL,
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fund_holdings_name_only_unique UNIQUE (fund_id, as_of_date, source, holding_name)
);

CREATE INDEX IF NOT EXISTS fund_holdings_name_only_fund_id_as_of_date_idx
  ON fund_holdings_name_only (fund_id, as_of_date);

-- Supabase auto-exposes new public-schema tables to anon/authenticated. Per CLAUDE.md's
-- "Supabase RLS" rule, every new table must close that in the same change:
ALTER TABLE fund_holdings_name_only ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fund_holdings_name_only FROM anon, authenticated;

-- No CREATE POLICY: written/read only by server-side code using the Postgres service-role
-- connection (Prisma via DATABASE_URL/DIRECT_URL), which bypasses RLS entirely. No anon/
-- authenticated access needed -- the App reads this data through existing Next.js API routes
-- (service-role DB access), never directly from a Supabase client.
