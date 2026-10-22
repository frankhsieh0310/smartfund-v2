CREATE TABLE "fund_documents" (
  "id" TEXT NOT NULL,
  "fund_id" TEXT NOT NULL,
  "share_class_id" TEXT,
  "document_type" TEXT NOT NULL,
  "document_title" TEXT,
  "document_date" DATE,
  "effective_date" DATE,
  "language" TEXT,
  "jurisdiction" TEXT,
  "url" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_record_id" TEXT,
  "content_hash" TEXT,
  "is_current" BOOLEAN,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fund_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fund_documents_fund_id_fkey" FOREIGN KEY ("fund_id") REFERENCES "funds"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fund_documents_share_class_id_fkey" FOREIGN KEY ("share_class_id") REFERENCES "fund_share_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "fund_documents_fund_id_document_type_is_current_idx" ON "fund_documents"("fund_id", "document_type", "is_current");
CREATE INDEX "fund_documents_share_class_id_document_type_idx" ON "fund_documents"("share_class_id", "document_type");
CREATE INDEX "fund_documents_source_source_record_id_idx" ON "fund_documents"("source", "source_record_id");
CREATE UNIQUE INDEX "fund_documents_identity_url_key" ON "fund_documents"("fund_id", COALESCE("share_class_id", ''), "document_type", "url");
