CREATE TABLE IF NOT EXISTS "bond_index_observations" (
  "index_id" TEXT NOT NULL,
  "metric_type" TEXT NOT NULL,
  "observation_date" DATE NOT NULL,
  "value" NUMERIC(30,12) NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "frequency" TEXT NOT NULL,
  "as_of" DATE NOT NULL,
  "known_at" TIMESTAMPTZ NOT NULL,
  "retrieved_at" TIMESTAMPTZ NOT NULL,
  "source" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "rights_classification" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bond_index_observations_pkey" PRIMARY KEY ("index_id", "metric_type", "observation_date", "source")
);

CREATE INDEX IF NOT EXISTS "bond_index_observations_metric_type_observation_date_idx"
  ON "bond_index_observations" ("metric_type", "observation_date");
