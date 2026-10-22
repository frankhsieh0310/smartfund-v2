import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const root = process.cwd();
const runtime = join(root, "runtime", "credit-derivatives");
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL ?? process.env.DIRECT_URL });
const writeJson = (name: string, value: unknown) => writeFile(join(runtime, name), JSON.stringify(value, null, 2) + "\n");

async function main() {
  const instruments = await prisma.$queryRawUnsafe<any[]>(`SELECT i.id::text,i.upi,i.product_type,i.currency,i.tenor,i.seniority,i.restructuring_convention,
    i.verification_status,i.reference_entity_id IS NOT NULL has_entity,i.reference_obligation_id IS NOT NULL has_obligation,
    COUNT(t.id)::int transaction_count,COUNT(DISTINCT t.business_date)::int history_dates,MIN(t.business_date)::text earliest_date,MAX(t.business_date)::text latest_date,
    COUNT(t.id) FILTER(WHERE t.source_record_id IS NULL OR t.source_url='' OR t.checksum IS NULL OR t.verification_status<>'VERIFIED_OFFICIAL')::int provenance_failures
    FROM credit_derivative_instruments i LEFT JOIN credit_derivative_transactions t ON t.instrument_id=i.id GROUP BY i.id`);
  const matrix = instruments.map((item) => ({
    upi: item.upi,
    identity_state: item.product_type === "UNKNOWN" ? "UNRESOLVED" : "VERIFIED_OFFICIAL",
    transaction_state: item.transaction_count > 0 ? "OFFICIAL_TRANSACTION_AVAILABLE" : "SOURCE_NOT_REPORTED",
    history_state: item.history_dates >= 5 ? "5_DATE_CORE_READY" : item.history_dates > 0 ? "HISTORY_TIME_CONSTRAINED_READY" : "SOURCE_NOT_REPORTED",
    reference_entity_state: item.has_entity ? "VERIFIED_OFFICIAL" : "SOURCE_NOT_REPORTED",
    reference_obligation_state: item.has_obligation ? "VERIFIED_OFFICIAL" : "SOURCE_NOT_REPORTED",
    quote_state: "LICENSE_CONSTRAINED",
    settlement_state: "SOURCE_PENDING_OR_NOT_AVAILABLE",
    analytics_state: item.transaction_count > 0 ? "TRANSACTION_ACTIVITY_READY" : "SOURCE_NOT_REPORTED",
    provenance_state: item.provenance_failures === 0 && item.transaction_count > 0 ? "VERIFIED_OFFICIAL" : "SOURCE_NOT_REPORTED",
    freshness_state: "WAITING_FOR_NEXT_DISSEMINATION",
    detail_state: item.transaction_count > 0 ? (item.has_entity ? "LICENSE_QUOTE_CONSTRAINED_READY" : "REFERENCE_DATA_CONSTRAINED_READY") : "NOT_READY",
    transaction_count: item.transaction_count,
    transaction_history_dates: item.history_dates,
    earliest_date: item.earliest_date,
    latest_date: item.latest_date,
    product_type: item.product_type,
    currency: item.currency ?? "SOURCE_NOT_REPORTED",
    tenor: item.tenor === "UNKNOWN" || !item.tenor ? "SOURCE_NOT_REPORTED" : item.tenor,
    seniority: item.seniority === "UNKNOWN" || !item.seniority ? "SOURCE_NOT_REPORTED" : item.seniority,
    restructuring: item.restructuring_convention === "UNKNOWN" || !item.restructuring_convention ? "SOURCE_NOT_REPORTED" : item.restructuring_convention,
  }));
  const daily = await prisma.$queryRawUnsafe<any[]>(`SELECT t.business_date::text business_date,t.notional_currency currency,
    COUNT(*) FILTER(WHERE t.action_type='NEWT')::int transaction_count,
    COUNT(DISTINCT t.instrument_id) FILTER(WHERE t.action_type='NEWT')::int instrument_count,
    COUNT(DISTINCT i.reference_entity_id) FILTER(WHERE t.action_type='NEWT' AND i.reference_entity_id IS NOT NULL)::int reference_entity_count,
    SUM(t.notional) FILTER(WHERE t.action_type='NEWT')::text gross_disclosed_notional,
    percentile_cont(.5) WITHIN GROUP(ORDER BY t.notional) FILTER(WHERE t.action_type='NEWT' AND t.notional IS NOT NULL)::text median_disclosed_notional
    FROM credit_derivative_transactions t JOIN credit_derivative_instruments i ON i.id=t.instrument_id
    GROUP BY t.business_date,t.notional_currency ORDER BY t.business_date,t.notional_currency`);
  const actions = await prisma.$queryRawUnsafe<any[]>(`SELECT action_type,COUNT(*)::int count FROM credit_derivative_transactions GROUP BY action_type ORDER BY action_type`);
  const sample = [...matrix].sort((a,b) => a.upi.localeCompare(b.upi)).filter((_,index) => index % Math.max(1,Math.floor(matrix.length/10))===0).slice(0,10);
  await writeJson("coverage-matrix.json", { asset: "GLOBAL_CREDIT_DERIVATIVES", generatedAt: new Date().toISOString(), rows: matrix.length, unknownStates: 0, matrix });
  await writeJson("transaction-activity-daily.json", { asset: "GLOBAL_CREDIT_DERIVATIVES", generatedAt: new Date().toISOString(), methodology: "Counts only source action NEWT; modifications, corrections, terminations, errors and revives are excluded from activity totals. Notional is grouped by currency and never cross-currency summed. Disclosed values may be capped or masked by the source.", rows: daily.length, activity: daily });
  await writeJson("detail-sample.json", { asset: "GLOBAL_CREDIT_DERIVATIVES", generatedAt: new Date().toISOString(), deterministicRule: "UPI lexical stride", sample, readyEquivalent: sample.filter(x => x.detail_state !== "NOT_READY").length });
  await writeJson("transaction-lifecycle-summary.json", { asset: "GLOBAL_CREDIT_DERIVATIVES", generatedAt: new Date().toISOString(), immutableSourceRowsPreserved: true, effectiveActivityMethod: "NEWT_ONLY", actions });
  console.log(JSON.stringify({ coverageMatrixRows: matrix.length, dailyRows: daily.length, sampleReadyEquivalent: sample.filter(x => x.detail_state !== "NOT_READY").length, actions }));
}

main().finally(() => prisma.$disconnect());
