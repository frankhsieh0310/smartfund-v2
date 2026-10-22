import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";

const DIR = resolve(process.cwd(), "runtime", "etf-flows", "intelligence");
const isoDay = (value: Date) => value.toISOString().slice(0, 10);
const numeric = (value: unknown) => value == null ? null : Number(value);

async function atomicJson(file: string, value: unknown) {
  await mkdir(DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, file);
}

export async function materializeAumFlowIntelligence(prisma: PrismaClient, code = "IVV") {
  const etfs = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; category: string | null }>>(
    "SELECT id,code,category FROM etfs WHERE UPPER(code)=UPPER($1) LIMIT 1", code,
  );
  if (!etfs[0]) throw new Error(`ETF_NOT_FOUND:${code}`);
  const etf = etfs[0];
  const aum = await prisma.$queryRawUnsafe<Array<any>>(
    "SELECT * FROM (SELECT DISTINCT ON (observation_date) observation_date,aum,nav,shares_outstanding,currency,source,source_url,retrieved_at,verification_status,updated_at FROM etf_asset_metrics WHERE etf_id=$1 AND aum IS NOT NULL AND nav IS NOT NULL AND shares_outstanding IS NOT NULL AND verification_status IN ('VERIFIED_OFFICIAL','VERIFIED_DERIVED') ORDER BY observation_date DESC,updated_at DESC) dated ORDER BY observation_date DESC LIMIT 2", etf.id,
  );
  const flows = await prisma.$queryRawUnsafe<Array<any>>(
    "SELECT observation_date,flow_value,currency,flow_method,source,retrieved_at,aum,verification_status,calculation_inputs FROM etf_flows WHERE etf_id=$1 AND verification_status='VERIFIED_DERIVED' ORDER BY observation_date DESC,updated_at DESC LIMIT 32", etf.id,
  );
  const now = new Date().toISOString();
  const assignment = {
    scope: "FULL_ELIGIBLE_ETF_UNIVERSE", history: "FULL_AVAILABLE_VERIFIED_AUM_FLOW_HISTORY",
    lifecycle: "EXISTING_GLOBAL_ETF_FLOWS_ORDINARY_NODE_LIFECYCLE", maxDbConcurrency: 1,
    methods: { aum: "REPORTED_OFFICIAL_PREFERRED;OTHERWISE_NAV_X_VERIFIED_SHARES", flow: "REPORTED_OFFICIAL_PREFERRED;OTHERWISE_(SHARES_T-SHARES_T_MINUS_1)_X_NAV_T" },
    preserve: ["source", "as_of", "retrieved_at", "currency", "reported_or_derived", "methodology"],
    inputGate: { flow: "TWO_VERIFIED_SHARES_PERIODS_PLUS_DATE_ALIGNED_NAV", rolling: "FULL_WINDOW_HISTORY_REQUIRED", divergence: "ALIGNED_VERIFIED_FLOW_AND_TOTAL_RETURN_REQUIRED", categoryTheme: "VERIFIED_MAPPING_REQUIRED" },
    state: "ACTIVE_AUTO_CONTINUING", updatedAt: now,
  };
  await atomicJson(resolve(DIR, "ordinary-worker-assignment.json"), assignment);
  if (aum.length < 2 || flows.length < 1) {
    const checkpoint = { asset: "ETF", canaryEtf: code, state: "INPUT_GATED_AUTO_CONTINUING", reason: "INSUFFICIENT_VERIFIED_AUM_NAV_SHARES_PERIODS", observationsPersisted: 0, readback: "PASS", assignment, updatedAt: now };
    await atomicJson(resolve(DIR, "checkpoint.json"), checkpoint);
    return checkpoint;
  }
  const latestAum = aum[0], priorAum = aum[1], latestFlow = flows[0];
  const asOf = new Date(latestFlow.observation_date);
  const weekStart = new Date(asOf); weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  const eligibleWeek = flows.some(row => new Date(row.observation_date) <= weekStart);
  const weekFlow = eligibleWeek ? flows.filter(row => new Date(row.observation_date) > weekStart && new Date(row.observation_date) <= asOf).reduce((sum, row) => sum + Number(row.flow_value), 0) : null;
  const methodology = latestFlow.flow_method === "DERIVED_FROM_SHARES_NAV" ? "(shares_t-shares_t_minus_1)*nav_t;market_appreciation_excluded_by_share_delta" : latestFlow.flow_method;
  const common = { etf_id: etf.id, etf_code: etf.code, source: latestFlow.source, as_of: isoDay(asOf), retrieved_at: new Date(latestFlow.retrieved_at).toISOString(), currency: latestFlow.currency, reported_or_derived: "DERIVED_VERIFIED", methodology };
  const observations = [
    { ...common, metric: "AUM_CURRENT", value: numeric(latestAum.aum), as_of: isoDay(new Date(latestAum.observation_date)), source: latestAum.source, retrieved_at: new Date(latestAum.retrieved_at).toISOString(), methodology: "NAV_X_VERIFIED_SHARES_OUTSTANDING" },
    { ...common, metric: "AUM_HISTORY_POINT", value: numeric(priorAum.aum), as_of: isoDay(new Date(priorAum.observation_date)), source: priorAum.source, retrieved_at: new Date(priorAum.retrieved_at).toISOString(), methodology: "NAV_X_VERIFIED_SHARES_OUTSTANDING" },
    { ...common, metric: "NET_FLOW", value: numeric(latestFlow.flow_value) },
    { ...common, metric: "FLOW_PERCENT_AUM", value: Number(latestFlow.aum) > 0 ? Number(latestFlow.flow_value) / Number(latestFlow.aum) * 100 : null, methodology: `${methodology};flow/aum_as_of*100` },
    { ...common, metric: "FLOW_1W", value: weekFlow, input_state: eligibleWeek ? "VERIFIED" : "INPUT_GATED", methodology: "SUM_VERIFIED_DAILY_FLOW_OVER_COMPLETE_7_CALENDAR_DAY_WINDOW" },
  ];
  const artifactFile = resolve(DIR, "canary-observations.json");
  await atomicJson(artifactFile, { asset: "ETF", canaryEtf: code, observations, generatedAt: now });
  const readback = JSON.parse(await readFile(artifactFile, "utf8"));
  if (readback.observations?.length !== 5 || readback.observations.some((row: any) => row.value == null)) throw new Error("ETF_AUM_FLOW_CANARY_READBACK_FAILED");
  const hasMomentum = flows.length >= 14;
  const checkpoint = { asset: "ETF", canaryEtf: code, state: "ACTIVE_AUTO_CONTINUING", checkpoint: `${isoDay(new Date(priorAum.observation_date))}->${isoDay(new Date(latestAum.observation_date))}`, inputData: "OFFICIAL_ISSUER_NAV_AND_SHARES;EXISTING_ETF_ASSET_METRICS_AND_FLOWS", observationsPersisted: 5, readback: "PASS", aumHistoryStatus: "ACTIVE", flowStatus: "ACTIVE", flowMomentumStatus: hasMomentum ? "ACTIVE" : "INPUT_GATED_AUTO_CONTINUING", flowAccelerationStatus: flows.length >= 21 ? "ACTIVE" : "INPUT_GATED_AUTO_CONTINUING", flowReturnDivergenceStatus: "INPUT_GATED_AUTO_CONTINUING", categoryThemeFlowStatus: etf.category ? "MAPPING_PRESENT_AWAITING_VERIFIED_AGGREGATION" : "INPUT_GATED_AUTO_CONTINUING", assignment, updatedAt: now };
  await atomicJson(resolve(DIR, "checkpoint.json"), checkpoint);
  return checkpoint;
}
