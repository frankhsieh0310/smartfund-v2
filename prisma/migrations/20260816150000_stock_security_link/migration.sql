CREATE TABLE "stock_security_links" (
    "id" UUID NOT NULL,
    "stock_id" TEXT NOT NULL,
    "security_id" TEXT NOT NULL,
    "mapping_source" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_security_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_security_links_stock_id_security_id_key"
    ON "stock_security_links"("stock_id", "security_id");

CREATE INDEX "stock_security_links_security_id_idx"
    ON "stock_security_links"("security_id");

CREATE INDEX "stock_security_links_verification_status_idx"
    ON "stock_security_links"("verification_status");

ALTER TABLE "stock_security_links"
    ADD CONSTRAINT "stock_security_links_stock_id_fkey"
    FOREIGN KEY ("stock_id") REFERENCES "stocks"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_security_links"
    ADD CONSTRAINT "stock_security_links_security_id_fkey"
    FOREIGN KEY ("security_id") REFERENCES "securities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
