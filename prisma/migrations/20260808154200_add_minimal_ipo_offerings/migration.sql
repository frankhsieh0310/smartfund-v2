CREATE TABLE IF NOT EXISTS "ipo_offerings" (
  "id" uuid PRIMARY KEY,
  "canonical_ipo_id" text NOT NULL UNIQUE,
  "company_name" text NOT NULL,
  "symbol" text,
  "market" text,
  "country" text,
  "event_date" date NOT NULL,
  "listing_date" date,
  "status" text NOT NULL,
  "source" text NOT NULL,
  "source_event_id" text NOT NULL,
  "source_payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ipo_offerings_source_source_event_id_key" UNIQUE ("source", "source_event_id")
);

CREATE INDEX IF NOT EXISTS "ipo_offerings_event_date_idx" ON "ipo_offerings" ("event_date");
CREATE INDEX IF NOT EXISTS "ipo_offerings_status_event_date_idx" ON "ipo_offerings" ("status", "event_date");
