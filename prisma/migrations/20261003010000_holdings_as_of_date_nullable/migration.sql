-- Fund/ETF holdings date-source constitution: a row with no reliable source date must be able to
-- store NULL rather than a fabricated fetch-date or NAV date. Loosens the one column; no data moved,
-- no other column touched.
ALTER TABLE "holdings" ALTER COLUMN "as_of_date" DROP NOT NULL;
