CREATE TABLE "etf_flows" (
    "id" UUID NOT NULL,
    "etf_id" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "flow_value" DECIMAL(28,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "flow_method" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "calculation_inputs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "etf_flows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "etf_flows_etf_date_method_key" ON "etf_flows"("etf_id", "observation_date", "flow_method");
CREATE INDEX "etf_flows_observation_date_idx" ON "etf_flows"("observation_date");
ALTER TABLE "etf_flows" ADD CONSTRAINT "etf_flows_etf_id_fkey" FOREIGN KEY ("etf_id") REFERENCES "etfs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
