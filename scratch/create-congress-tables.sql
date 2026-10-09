-- P0-2A — minimal canonical tables for congressional trade disclosures (House first).
-- Additive only: new tables, no change to any existing table. Applied via raw SQL (not `prisma
-- migrate`) to avoid picking up unrelated pending schema.prisma changes from other in-progress work
-- in this shared repo — these two tables are not modeled in Prisma this round; routes/scripts use
-- prisma.$queryRawUnsafe against them, the same pattern already used for institutional_holdings.

CREATE TABLE IF NOT EXISTS political_persons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  chamber          text NOT NULL CHECK (chamber IN ('HOUSE', 'SENATE')),
  state            text,
  party            text,
  source_person_id text NOT NULL, -- e.g. House Clerk "Last,First,StateDst" composite key
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chamber, source_person_id)
);

CREATE TABLE IF NOT EXISTS political_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           uuid NOT NULL REFERENCES political_persons(id) ON DELETE CASCADE,
  security_id         text REFERENCES securities(id),
  stock_id            text REFERENCES stocks(id),
  asset_name          text NOT NULL,
  ticker              text,
  transaction_type    text NOT NULL,       -- P (purchase) / S (sale, incl. partial) / E (exchange)
  transaction_date    date NOT NULL,
  disclosure_date     date NOT NULL,       -- filing date — always kept separate from transaction_date
  amount_min          numeric(18,2),
  amount_max          numeric(18,2),
  owner               text,                -- Self / Spouse / Joint / Dependent Child
  source_url          text NOT NULL,
  source_document_id  text NOT NULL,       -- House Clerk DocID
  filing_year         integer NOT NULL,
  mapping_method      text,                -- TICKER_EXACT / CUSIP_EXACT / NORMALIZED_NAME / UNMAPPED
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- dedup: same person + filing + asset + transaction date/type + amount range must never duplicate,
  -- even across re-runs or an amended filing that repeats an unchanged line item.
  UNIQUE (person_id, source_document_id, asset_name, transaction_date, transaction_type, amount_min, amount_max)
);

CREATE INDEX IF NOT EXISTS idx_political_transactions_ticker ON political_transactions (ticker);
CREATE INDEX IF NOT EXISTS idx_political_transactions_stock_id ON political_transactions (stock_id);
CREATE INDEX IF NOT EXISTS idx_political_transactions_person ON political_transactions (person_id);
CREATE INDEX IF NOT EXISTS idx_political_transactions_disclosure_date ON political_transactions (disclosure_date);
