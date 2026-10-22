import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Papa from "papaparse";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, string>;
const root = process.cwd();
const runtime = join(root, "runtime", "credit-derivatives");
const sourceDir = join(runtime, "source");
const checkpointPath = join(runtime, "checkpoint.json");
const heartbeatPath = join(runtime, "heartbeat.json");
const manifestPath = join(runtime, "completion-manifest.json");
const logPath = join(runtime, "credit-derivatives.log");
const sourceName = "DTCC DDR SEC Public Price Dissemination";
const market = "SEC SECURITY-BASED SWAPS";
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL ?? process.env.DIRECT_URL });
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function atomic(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n");
  await rename(temp, path);
}
async function json(path: string, fallback: any = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
async function log(event: string, detail: Record<string, unknown> = {}) {
  await writeFile(logPath, `${now()} ${event} ${JSON.stringify(detail)}\n`, { flag: "a" });
}
async function publish(state: any, patch: Record<string, unknown>) {
  Object.assign(state, patch, { asset: "GLOBAL_CREDIT_DERIVATIVES", pid: process.pid, processAlive: true, updatedAt: now() });
  await atomic(checkpointPath, state); await atomic(heartbeatPath, state);
}
function isoDate(date: Date) { return date.toISOString().slice(0, 10); }
function sourceDates(count: number) {
  const values: string[] = []; const cursor = new Date(); cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (values.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) values.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return values;
}
function numeric(value: unknown) {
  const normalized = String(value ?? "").replaceAll(",", "").replace(/\+$/, "").trim();
  if (!normalized) return null;
  const number = Number(normalized); return Number.isFinite(number) ? number : null;
}
function dateValue(value: string | undefined) { return /^\d{4}-\d{2}-\d{2}/.test(value ?? "") ? value!.slice(0, 10) : null; }
function timestamp(value: string | undefined) { return /^\d{4}-\d{2}-\d{2}T/.test(value ?? "") ? new Date(value!).toISOString() : null; }
function productType(fisn: string) {
  if (fisn.includes("CDS Sov SN")) return "SOVEREIGN_CDS";
  if (fisn.includes("CDS Corp SN")) return "SINGLE_NAME_CDS";
  if (fisn.includes("CDS") && fisn.includes("Index")) return "INDEX_CDS";
  if (fisn.includes("CDS") && fisn.includes("Tranche")) return "TRANCHE";
  return fisn.includes("CDS") ? "OTHER_CREDIT_SWAP" : "UNKNOWN";
}
function entityType(product: string) { return product === "SOVEREIGN_CDS" ? "SOVEREIGN" : product === "SINGLE_NAME_CDS" ? "CORPORATE" : "UNKNOWN"; }
function seniority(fisn: string, product: string) {
  if (product === "SOVEREIGN_CDS") return "SOVEREIGN";
  if (/\bSub\b/.test(fisn)) return "SUBORDINATED";
  return fisn.includes("CDS") ? "UNKNOWN" : null;
}
function tenor(effective: string | null, maturity: string | null) {
  if (!effective || !maturity) return "UNKNOWN";
  const days = (Date.parse(`${maturity}T00:00:00Z`) - Date.parse(`${effective}T00:00:00Z`)) / 86_400_000;
  const buckets: Array<[number, string]> = [[183,"6M"],[365,"1Y"],[730,"2Y"],[1095,"3Y"],[1826,"5Y"],[2557,"7Y"],[3652,"10Y"]];
  return buckets.find(([target]) => Math.abs(days - target) <= 45)?.[1] ?? "OTHER";
}

function download(date: string) {
  const key = date.replaceAll("-", "_");
  const url = `https://pddata.dtcc.com/ppd/api/report/cumulative/sec/SEC_CUMULATIVE_CREDITS_${key}.zip`;
  const zipPath = join(sourceDir, `SEC_CUMULATIVE_CREDITS_${key}.zip`);
  execFileSync("curl.exe", ["-fL", "--max-time", "60", "-sS", url, "-o", zipPath], { stdio: "pipe" });
  const bytes = execFileSync("tar", ["-xOf", zipPath, `SEC_CUMULATIVE_CREDITS_${key}.csv`], { maxBuffer: 128 * 1024 * 1024 });
  const csv = bytes.toString("utf8");
  if (!csv.includes("Dissemination Identifier") || !csv.includes("Unique Product Identifier")) throw new Error("DTCC_CREDIT_CSV_SCHEMA_INVALID");
  return { url, csv, checksum: createHash("sha256").update(bytes).digest("hex") };
}

function validRows(csv: string) {
  const parsed = Papa.parse<Row>(csv, { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`DTCC_CSV_PARSE_${parsed.errors[0].code}`);
  return parsed.data.filter((row) => row["Asset Class"] === "CR" && row["UPI FISN"]?.includes("CDS") && Boolean(row["Unique Product Identifier"]) && Boolean(row["Dissemination Identifier"]));
}

async function canonicalize(row: Row, businessDate: string, url: string, checksum: string) {
  const upi = row["Unique Product Identifier"];
  const fisn = row["UPI FISN"] ?? "";
  const product = productType(fisn);
  const officialName = (row["UPI Underlier Name"] ?? "").trim();
  const usableName = officialName && officialName !== "No name obtainable" ? officialName : null;
  let entityId: string | null = null;
  if (usableName && ["SINGLE_NAME_CDS", "SOVEREIGN_CDS"].includes(product)) {
    const rows = await prisma.$queryRawUnsafe<any[]>(`INSERT INTO credit_reference_entities
      (id,official_name,entity_type,external_identifiers,status,source,verification_status,created_at,updated_at)
      VALUES ($1::uuid,$2,$3,$4::jsonb,'ACTIVE',$5,'VERIFIED_OFFICIAL',NOW(),NOW())
      ON CONFLICT (source,official_name) DO UPDATE SET entity_type=EXCLUDED.entity_type,updated_at=NOW()
      RETURNING id::text`, randomUUID(), usableName, entityType(product), JSON.stringify({ upi }), sourceName);
    entityId = rows[0].id;
  }
  const underlierId = (row["Underlier ID-Leg 1"] ?? "").trim();
  const underlierSource = row["Underlier ID source-Leg 1"] ?? "";
  const isin = underlierSource === "ISIN" && underlierId ? underlierId : null;
  let obligationId: string | null = null;
  if (isin) {
    const rows = await prisma.$queryRawUnsafe<any[]>(`INSERT INTO credit_reference_obligations
      (id,reference_entity_id,obligation_type,isin,currency,seniority,maturity_date,status,source,verification_status,created_at,updated_at)
      VALUES ($1::uuid,$2::uuid,'REFERENCE_SECURITY',$3,$4,$5,$6::date,'ACTIVE',$7,'VERIFIED_OFFICIAL',NOW(),NOW())
      ON CONFLICT (source,isin) DO UPDATE SET reference_entity_id=COALESCE(EXCLUDED.reference_entity_id,credit_reference_obligations.reference_entity_id),currency=COALESCE(EXCLUDED.currency,credit_reference_obligations.currency),maturity_date=COALESCE(EXCLUDED.maturity_date,credit_reference_obligations.maturity_date),updated_at=NOW()
      RETURNING id::text`, randomUUID(), entityId, isin, row["Notional currency-Leg 1"] || null, seniority(fisn, product), dateValue(row["Maturity date of the underlier"]), sourceName);
    obligationId = rows[0].id;
  }
  const effective = dateValue(row["Effective Date"]); const maturity = dateValue(row["Expiration Date"]);
  const instruments = await prisma.$queryRawUnsafe<any[]>(`INSERT INTO credit_derivative_instruments
    (id,upi,product_type,reference_entity_id,reference_obligation_id,currency,tenor,seniority,restructuring_convention,effective_date,maturity_date,source_taxonomy,status,source,verification_status,created_at,updated_at)
    VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,'UNKNOWN',$9::date,$10::date,$11,'ACTIVE',$12,'VERIFIED_OFFICIAL',NOW(),NOW())
    ON CONFLICT (upi) DO UPDATE SET product_type=EXCLUDED.product_type,reference_entity_id=COALESCE(EXCLUDED.reference_entity_id,credit_derivative_instruments.reference_entity_id),reference_obligation_id=COALESCE(EXCLUDED.reference_obligation_id,credit_derivative_instruments.reference_obligation_id),currency=COALESCE(EXCLUDED.currency,credit_derivative_instruments.currency),tenor=EXCLUDED.tenor,seniority=EXCLUDED.seniority,effective_date=COALESCE(EXCLUDED.effective_date,credit_derivative_instruments.effective_date),maturity_date=COALESCE(EXCLUDED.maturity_date,credit_derivative_instruments.maturity_date),source_taxonomy=EXCLUDED.source_taxonomy,updated_at=NOW()
    RETURNING id::text`, randomUUID(), upi, product, entityId, obligationId, row["Notional currency-Leg 1"] || null, tenor(effective, maturity), seniority(fisn, product), effective, maturity, fisn || null, sourceName);
  const price = numeric(row["Price"]); const priceType = price === null ? null : (row["Price notation"] || row["Price unit of measure"] || "UNKNOWN");
  await prisma.$executeRawUnsafe(`INSERT INTO credit_derivative_transactions
    (id,instrument_id,market,business_date,execution_timestamp,dissemination_timestamp,action_type,event_type,notional,notional_currency,transaction_price,transaction_price_type,transaction_spread_leg_1,transaction_spread_leg_2,source,source_url,source_record_id,retrieved_at,source_version,checksum,verification_status,observation_type,created_at,updated_at)
    VALUES ($1::uuid,$2::uuid,$3,$4::date,$5::timestamptz,$6::timestamptz,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18,$19,'VERIFIED_OFFICIAL','TRANSACTION',NOW(),NOW())
    ON CONFLICT (source,source_record_id) DO UPDATE SET action_type=EXCLUDED.action_type,event_type=EXCLUDED.event_type,notional=EXCLUDED.notional,notional_currency=EXCLUDED.notional_currency,transaction_price=EXCLUDED.transaction_price,transaction_price_type=EXCLUDED.transaction_price_type,transaction_spread_leg_1=EXCLUDED.transaction_spread_leg_1,transaction_spread_leg_2=EXCLUDED.transaction_spread_leg_2,retrieved_at=NOW(),checksum=EXCLUDED.checksum,updated_at=NOW()`,
    randomUUID(), instruments[0].id, market, businessDate, timestamp(row["Execution Timestamp"]), timestamp(row["Event timestamp"]), row["Action type"] || null, row["Event type"] || null, numeric(row["Notional amount-Leg 1"]), row["Notional currency-Leg 1"] || null, price, priceType, numeric(row["Spread-Leg 1"]), numeric(row["Spread-Leg 2"]), sourceName, url, row["Dissemination Identifier"], businessDate, checksum);
}

async function seedLicenseRegister() {
  const entries = [
    ["CDX_BENCHMARK_QUOTES_AND_CONSTITUENTS","S&P Global","[\"quotes\",\"series\",\"constituents\"]"],
    ["ITRAXX_BENCHMARK_QUOTES_AND_CONSTITUENTS","S&P Global","[\"quotes\",\"series\",\"constituents\"]"],
    ["SINGLE_NAME_CDS_COMPOSITE_QUOTES","Commercial evaluated-pricing provider required","[\"bid\",\"ask\",\"mid\",\"upfront\",\"recovery\"]"],
  ];
  for (const [domain, provider, required] of entries) await prisma.$executeRawUnsafe(`INSERT INTO credit_derivative_license_register
    (id,domain,provider,required_data,license_status,redistribution_status,automation_status,notes,created_at,updated_at)
    VALUES ($1::uuid,$2,$3,$4::jsonb,'LICENSE_REQUIRED','NOT_AUTHORIZED','DISABLED','No unlicensed scraping or substitution',NOW(),NOW())
    ON CONFLICT (domain) DO UPDATE SET provider=EXCLUDED.provider,required_data=EXCLUDED.required_data,updated_at=NOW()`, randomUUID(), domain, provider, required);
}

async function ingestDate(date: string) {
  const downloaded = download(date); const rows = validRows(downloaded.csv); let inserted = 0;
  for (const row of rows) { await canonicalize(row, date, downloaded.url, downloaded.checksum); inserted += 1; }
  await log("DTCC_DATE_COMPLETE", { date, rows: inserted, checksum: downloaded.checksum });
  return inserted;
}

async function census() {
  const rows = await prisma.$queryRawUnsafe<any[]>(`SELECT
    (SELECT COUNT(*)::int FROM credit_derivative_transactions) transaction_rows,
    (SELECT COUNT(DISTINCT business_date)::int FROM credit_derivative_transactions) transaction_dates,
    (SELECT COUNT(*)::int FROM credit_derivative_instruments) instruments,
    (SELECT COUNT(*)::int FROM credit_reference_entities) reference_entities,
    (SELECT COUNT(*)::int FROM credit_reference_obligations) reference_obligations,
    (SELECT COUNT(*)::int FROM credit_derivative_market_quotes) quote_rows,
    (SELECT COUNT(DISTINCT as_of::date)::int FROM credit_derivative_market_quotes) quote_dates`);
  return rows[0];
}

async function main() {
  await mkdir(sourceDir, { recursive: true });
  const state = await json(checkpointPath, { cycle: 0 });
  await seedLicenseRegister();
  await publish(state, { stage: "HISTORICAL_TRANSACTION", status: "RUNNING", observationDomain: "TRANSACTION", quoteStatus: "LICENSE_REQUIRED", workQueue: sourceDates(5) });
  await log("RUNNER_STARTED", { pid: process.pid, ownership: "REUSED_SINGLE_WRITER", dates: state.workQueue });
  while (true) {
    const queue = state.workQueue?.length ? state.workQueue : sourceDates(1);
    for (const date of [...queue]) {
      try {
        await publish(state, { stage: "HISTORICAL_TRANSACTION", status: "RUNNING", currentWork: { market, businessDate: date, cursor: null } });
        await ingestDate(date); state.workQueue = state.workQueue?.filter((item: string) => item !== date) ?? [];
      } catch (error: any) {
        const message = String(error?.message ?? error); await log("BOUNDED_RETRY", { date, error: message });
        await atomic(join(runtime, "failure-queue.json"), [{ market, businessDate: date, cursor: null, source: sourceName, error: message, failedAt: now(), boundedRetry: true }]);
      }
    }
    state.cycle = (state.cycle ?? 0) + 1; const counts = await census();
    await publish(state, { stage: "INCREMENTAL_WAIT", status: "CURRENT", dataset: "SEC_CREDIT_DERIVATIVE_TRANSACTIONS", observationDomain: "TRANSACTION", marketQuoteStatus: "LICENSE_REQUIRED", counts, currentWork: null, nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    await atomic(manifestPath, { asset: state.asset, completedAt: now(), source: sourceName, canonicalTargets: ["credit_reference_entities","credit_reference_obligations","credit_derivative_instruments","credit_derivative_transactions"], observationDomain: "TRANSACTION", marketQuoteStatus: "LICENSE_REQUIRED", sourceClassification: "OFFICIAL_PUBLIC", counts, historicalDatesRequested: sourceDates(5), latestPath: true, incremental: true, scheduler: "ACTIVE", autoContinuing: true });
    await sleep(60 * 60_000); state.workQueue = sourceDates(1);
  }
}

process.on("SIGTERM", () => { void log("SIGTERM", { ownership: "REUSED_SINGLE_WRITER" }).finally(() => process.exit(0)); });
main().catch(async (error) => { try { await log("FATAL", { error: String(error) }); } finally { await prisma.$disconnect(); process.exitCode = 1; } });
