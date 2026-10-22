CREATE TABLE "etf_distribution_events" (
  "id" UUID NOT NULL,
  "etf_id" TEXT NOT NULL,
  "share_class_id" TEXT NOT NULL DEFAULT 'PRIMARY',
  "ex_date" DATE NOT NULL,
  "record_date" DATE,
  "payment_date" DATE,
  "announcement_date" DATE,
  "effective_date" DATE NOT NULL,
  "amount" DECIMAL(24,10) NOT NULL,
  "currency" TEXT NOT NULL,
  "distribution_type" TEXT,
  "source" TEXT NOT NULL,
  "source_record_id" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL,
  "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "etf_distribution_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "etf_distribution_events_etf_id_fkey" FOREIGN KEY ("etf_id") REFERENCES "etfs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "etf_distribution_events_etf_id_share_class_id_ex_date_source_source_record_id_key"
  ON "etf_distribution_events"("etf_id", "share_class_id", "ex_date", "source", "source_record_id");

CREATE INDEX "etf_distribution_events_etf_id_ex_date_idx"
  ON "etf_distribution_events"("etf_id", "ex_date");

CREATE INDEX "etf_distribution_events_source_verification_status_idx"
  ON "etf_distribution_events"("source", "verification_status");
