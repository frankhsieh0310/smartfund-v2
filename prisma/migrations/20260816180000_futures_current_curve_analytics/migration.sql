CREATE TABLE IF NOT EXISTS "futures_curve_snapshots" (
  "id" uuid PRIMARY KEY,
  "root_id" uuid NOT NULL REFERENCES "futures_product_roots"("id") ON DELETE CASCADE,
  "contract_id" uuid NOT NULL REFERENCES "futures_contracts"("id") ON DELETE CASCADE,
  "as_of_date" date NOT NULL,
  "source_observed_at" timestamptz NOT NULL,
  "sequence_rank" integer NOT NULL,
  "price_field" text NOT NULL,
  "price_value" numeric(24,8) NOT NULL,
  "days_to_expiry" integer,
  "volume" bigint,
  "open_interest" bigint,
  "source" text NOT NULL,
  "methodology_version" text NOT NULL,
  "calculated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "futures_curve_snapshot_identity" UNIQUE ("root_id","contract_id","as_of_date","methodology_version"),
  CONSTRAINT "futures_curve_snapshot_rank" UNIQUE ("root_id","as_of_date","sequence_rank","methodology_version")
);
CREATE INDEX IF NOT EXISTS "futures_curve_snapshots_date_idx" ON "futures_curve_snapshots" ("as_of_date");

CREATE TABLE IF NOT EXISTS "futures_curve_metrics" (
  "id" uuid PRIMARY KEY,
  "root_id" uuid NOT NULL REFERENCES "futures_product_roots"("id") ON DELETE CASCADE,
  "as_of_date" date NOT NULL,
  "metric_key" text NOT NULL,
  "start_rank" integer NOT NULL DEFAULT 0,
  "end_rank" integer NOT NULL DEFAULT 0,
  "numeric_value" numeric(30,12),
  "state_value" text,
  "parameters" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "methodology_version" text NOT NULL,
  "calculated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "futures_curve_metric_identity" UNIQUE ("root_id","as_of_date","metric_key","start_rank","end_rank","methodology_version")
);
CREATE INDEX IF NOT EXISTS "futures_curve_metrics_date_key_idx" ON "futures_curve_metrics" ("as_of_date","metric_key");
