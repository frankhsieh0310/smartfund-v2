ALTER TABLE "funds"
ADD COLUMN "legal_name" TEXT,
ADD COLUMN "domicile" TEXT;

CREATE TABLE "fund_share_classes" (
    "id" TEXT NOT NULL,
    "fund_id" TEXT NOT NULL,
    "share_class_name" TEXT NOT NULL,
    "share_class_code" TEXT,
    "isin" TEXT,
    "currency" TEXT,
    "distribution_type" TEXT,
    "hedged_currency" TEXT,
    "inception_date" DATE,
    "termination_date" DATE,
    "status" TEXT NOT NULL,
    "domicile" TEXT,
    "source" TEXT NOT NULL,
    "source_record_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fund_share_classes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fund_share_classes_isin_key"
ON "fund_share_classes"("isin");

CREATE UNIQUE INDEX "fund_share_classes_fund_id_source_source_record_id_key"
ON "fund_share_classes"("fund_id", "source", "source_record_id");

CREATE INDEX "fund_share_classes_fund_id_idx"
ON "fund_share_classes"("fund_id");

CREATE INDEX "fund_share_classes_source_status_idx"
ON "fund_share_classes"("source", "status");

ALTER TABLE "fund_share_classes"
ADD CONSTRAINT "fund_share_classes_fund_id_fkey"
FOREIGN KEY ("fund_id") REFERENCES "funds"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
