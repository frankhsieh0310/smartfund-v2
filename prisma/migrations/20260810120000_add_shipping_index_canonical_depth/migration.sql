-- Additive, license-aware canonical shipping-index depth relations.
-- The pre-existing shipping_market_observations relation is intentionally retained
-- as a separate SHIPPING_CONTEXT_INDICATOR domain.

CREATE TABLE IF NOT EXISTS "shipping_indices" (
  "index_id" TEXT NOT NULL,
  "official_name" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "segment" TEXT NOT NULL,
  "vessel_class" TEXT,
  "route_scope" TEXT,
  "freight_type" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "frequency" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "jurisdiction" TEXT,
  "official_source" TEXT NOT NULL,
  "external_identifier" TEXT,
  "status" TEXT NOT NULL,
  "launch_date" DATE,
  "termination_date" DATE,
  "license_status" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shipping_indices_pkey" PRIMARY KEY ("index_id")
);

CREATE INDEX IF NOT EXISTS "shipping_indices_provider_segment_idx" ON "shipping_indices"("provider", "segment");

CREATE TABLE IF NOT EXISTS "shipping_index_observations" (
  "id" UUID NOT NULL,
  "index_id" TEXT NOT NULL,
  "observation_date" DATE NOT NULL,
  "publication_date" DATE,
  "value" DECIMAL(30,10) NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "frequency" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_record_id" TEXT,
  "source_reference" TEXT,
  "source_url" TEXT,
  "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "parser_version" TEXT NOT NULL,
  "source_version" TEXT NOT NULL,
  "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verification_status" TEXT NOT NULL,
  "license_status" TEXT NOT NULL,
  "quality_status" TEXT NOT NULL,
  CONSTRAINT "shipping_index_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shipping_index_observations_index_id_fkey" FOREIGN KEY ("index_id") REFERENCES "shipping_indices"("index_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "shipping_index_observations_index_date_source_version_key" ON "shipping_index_observations"("index_id", "observation_date", "source_version");
CREATE INDEX IF NOT EXISTS "shipping_index_observations_index_date_idx" ON "shipping_index_observations"("index_id", "observation_date");

CREATE TABLE IF NOT EXISTS "shipping_index_derived" (
  "id" UUID NOT NULL,
  "index_id" TEXT NOT NULL,
  "observation_date" DATE NOT NULL,
  "metric" TEXT NOT NULL,
  "window" TEXT NOT NULL,
  "value" DECIMAL(30,10),
  "formula" TEXT NOT NULL,
  "input_series" JSONB NOT NULL,
  "formula_version" TEXT NOT NULL,
  "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_index_derived_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shipping_index_derived_index_id_fkey" FOREIGN KEY ("index_id") REFERENCES "shipping_indices"("index_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "shipping_index_derived_index_date_metric_window_version_key" ON "shipping_index_derived"("index_id", "observation_date", "metric", "window", "formula_version");
CREATE INDEX IF NOT EXISTS "shipping_index_derived_metric_date_idx" ON "shipping_index_derived"("metric", "observation_date");

CREATE TABLE IF NOT EXISTS "shipping_index_methodologies" (
  "index_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "methodology_url" TEXT,
  "index_objective" TEXT NOT NULL,
  "segment" TEXT NOT NULL,
  "vessel_class" TEXT,
  "route_scope" TEXT,
  "calculation_method" TEXT,
  "weighting_method" TEXT,
  "basket_definition" TEXT,
  "publication_frequency" TEXT NOT NULL,
  "review_frequency" TEXT,
  "effective_date" DATE,
  "source" TEXT NOT NULL,
  "license_status" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_index_methodologies_pkey" PRIMARY KEY ("index_id"),
  CONSTRAINT "shipping_index_methodologies_index_id_fkey" FOREIGN KEY ("index_id") REFERENCES "shipping_indices"("index_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "shipping_index_routes" (
  "route_id" TEXT NOT NULL,
  "index_id" TEXT,
  "route_name" TEXT NOT NULL,
  "origin" TEXT,
  "destination" TEXT,
  "vessel_class" TEXT,
  "cargo_type" TEXT,
  "freight_type" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "provider" TEXT NOT NULL,
  "source_status" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_index_routes_pkey" PRIMARY KEY ("route_id"),
  CONSTRAINT "shipping_index_routes_index_id_fkey" FOREIGN KEY ("index_id") REFERENCES "shipping_indices"("index_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "shipping_index_events" (
  "id" UUID NOT NULL,
  "index_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "announcement_date" DATE,
  "effective_date" DATE NOT NULL,
  "source" TEXT NOT NULL,
  "source_record_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_index_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shipping_index_events_index_id_fkey" FOREIGN KEY ("index_id") REFERENCES "shipping_indices"("index_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "shipping_index_coverage" (
  "index_id" TEXT NOT NULL,
  "identity_status" TEXT NOT NULL,
  "source_status" TEXT NOT NULL,
  "license_status" TEXT NOT NULL,
  "current_available" BOOLEAN NOT NULL DEFAULT false,
  "history_available" BOOLEAN NOT NULL DEFAULT false,
  "history_first_date" DATE,
  "history_last_date" DATE,
  "frequency" TEXT NOT NULL,
  "methodology_status" TEXT NOT NULL,
  "route_data_status" TEXT NOT NULL,
  "analytics_status" TEXT NOT NULL,
  "provenance_status" TEXT NOT NULL,
  "freshness_status" TEXT NOT NULL,
  "coverage_status" TEXT NOT NULL,
  "last_checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_index_coverage_pkey" PRIMARY KEY ("index_id"),
  CONSTRAINT "shipping_index_coverage_index_id_fkey" FOREIGN KEY ("index_id") REFERENCES "shipping_indices"("index_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
