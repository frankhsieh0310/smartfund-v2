CREATE TABLE IF NOT EXISTS "corporate_actions" (
  "id" uuid PRIMARY KEY,
  "security_id" text NOT NULL REFERENCES "securities"("id"),
  "action_type" text NOT NULL,
  "announcement_date" date NOT NULL,
  "effective_date" date,
  "amount" numeric(30,6),
  "share_count" numeric(30,6),
  "currency" text,
  "status" text NOT NULL,
  "source" text NOT NULL,
  "source_event_id" text NOT NULL,
  "source_url" text,
  "source_payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "corporate_actions_source_event_type_key" UNIQUE ("source", "source_event_id", "action_type")
);

CREATE INDEX IF NOT EXISTS "corporate_actions_type_announcement_idx" ON "corporate_actions" ("action_type", "announcement_date");
CREATE INDEX IF NOT EXISTS "corporate_actions_security_announcement_idx" ON "corporate_actions" ("security_id", "announcement_date");
