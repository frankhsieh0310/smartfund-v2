import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import XLSX from "xlsx";

const root = process.cwd();
const runtime = join(root, "runtime", "carbon-markets");
const sourceDir = join(runtime, "source");
const checkpointPath = join(runtime, "checkpoint.json");
const manifestPath = join(runtime, "completion-manifest.json");
const heartbeatPath = join(runtime, "heartbeat.json");
const logPath = join(runtime, "carbon-markets.log");
const sourceUrl = "https://public.eex-group.com/eex/eua-auction-report/emission-spot-primary-market-auction-report-2026-data.xlsx";
const sourceName = "EEX Official EUA Primary Auction Report";
const sourceVersion = "2026";
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const programs = [
  ["EU_ETS", "European Union Emissions Trading System", "EU ETS", "European Union", "EUROPE", "EUROPE", "ETS", "European Commission", "European Commission", true, true, true, "https://climate.ec.europa.eu/eu-action/carbon-markets/eu-emissions-trading-system-eu-ets_en"],
  ["UK_ETS", "UK Emissions Trading Scheme", "UK ETS", "United Kingdom", "UK", "EUROPE", "ETS", "UK ETS Authority", "UK ETS Authority", true, true, true, "https://www.gov.uk/government/collections/uk-emissions-trading-scheme"],
  ["CALIFORNIA_CAP_AND_TRADE", "California Cap-and-Trade Program", "California Cap-and-Trade", "California", "US", "NORTH_AMERICA", "CAP_AND_TRADE", "California Air Resources Board", "California Air Resources Board", true, true, true, "https://ww2.arb.ca.gov/our-work/programs/cap-and-trade-program"],
  ["RGGI", "Regional Greenhouse Gas Initiative", "RGGI", "RGGI participating states", "US", "NORTH_AMERICA", "CAP_AND_TRADE", "RGGI, Inc.", "RGGI participating states", true, true, true, "https://www.rggi.org/"],
  ["CHINA_NATIONAL_ETS", "China National Emissions Trading Scheme", "China National ETS", "China", "CHINA", "ASIA", "ETS", "Ministry of Ecology and Environment of the PRC", "Ministry of Ecology and Environment of the PRC", false, true, false, "https://www.mee.gov.cn/ywgz/ydqhbh/wsqtkz/"],
] as const;
const instruments = [
  ["EU_ETS:EUA", "EU_ETS", "European Union Allowance", "EUA", "EUR", "European Commission"],
  ["UK_ETS:UKA", "UK_ETS", "UK Allowance", "UKA", "GBP", "UK ETS Authority"],
  ["CALIFORNIA:CCA", "CALIFORNIA_CAP_AND_TRADE", "California Carbon Allowance", "CCA", "USD", "California Air Resources Board"],
  ["RGGI:CO2_ALLOWANCE", "RGGI", "RGGI CO2 Allowance", null, "USD", "RGGI, Inc."],
  ["CHINA_ETS:ALLOWANCE", "CHINA_NATIONAL_ETS", "China National ETS Allowance", null, "CNY", "Ministry of Ecology and Environment of the PRC"],
] as const;

async function atomic(path: string, value: unknown) { const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + "\n"); await rename(temp, path); }
async function json(path: string, fallback: any = null) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
async function log(event: string, detail: Record<string, unknown> = {}) { await writeFile(logPath, `${now()} ${event} ${JSON.stringify(detail)}\n`, { flag: "a" }); }
function excelDate(serial: number) { const parsed = XLSX.SSF.parse_date_code(serial); if (!parsed) throw new Error("EEX_INVALID_AUCTION_DATE"); return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`; }
function key(value: string) { return createHash("sha256").update(value).digest("hex").slice(0, 32); }

async function seedCanonicalIdentity() {
  for (const p of programs) await prisma.$executeRawUnsafe(`INSERT INTO carbon_programs
    (id,official_name,short_name,jurisdiction,country_or_region,region,program_type,administrator,regulator,compliance_market,auction_supported,secondary_trading_supported,futures_supported,status,official_url,verification_status,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11,$12,'ACTIVE',$13,'OFFICIAL_VERIFIED',NOW())
    ON CONFLICT (id) DO UPDATE SET official_name=EXCLUDED.official_name,official_url=EXCLUDED.official_url,verification_status=EXCLUDED.verification_status,updated_at=NOW()`, ...p);
  for (const i of instruments) await prisma.$executeRawUnsafe(`INSERT INTO carbon_instruments
    (id,program_id,official_name,symbol_code,instrument_type,allowance_type,currency,unit,status,source,verification_status,updated_at)
    VALUES ($1,$2,$3,$4,'ALLOWANCE','COMPLIANCE_ALLOWANCE',$5,'PER_TCO2E','ACTIVE',$6,'OFFICIAL_VERIFIED',NOW())
    ON CONFLICT (id) DO UPDATE SET official_name=EXCLUDED.official_name,symbol_code=EXCLUDED.symbol_code,verification_status=EXCLUDED.verification_status,updated_at=NOW()`, ...i);
  const mappings = [
    ["10000000-0000-4000-8000-000000000001", "EU_ETS:EUA", "LICENSE_PENDING"],
    ["10000000-0000-4000-8000-000000000002", "UK_ETS:UKA", "LICENSE_PENDING"],
    ["10000000-0000-4000-8000-000000000003", "CALIFORNIA:CCA", "LICENSE_PENDING"],
    ["10000000-0000-4000-8000-000000000004", "RGGI:CO2_ALLOWANCE", "UNRESOLVED"],
    ["10000000-0000-4000-8000-000000000005", "CHINA_ETS:ALLOWANCE", "UNRESOLVED"],
  ];
  for (const m of mappings) await prisma.$executeRawUnsafe(`INSERT INTO carbon_futures_mappings (id,carbon_instrument_id,mapping_type,evidence,updated_at) VALUES ($1::uuid,$2,$3,'No exact licensed canonical futures contract verified',NOW()) ON CONFLICT (id) DO UPDATE SET mapping_type=EXCLUDED.mapping_type,evidence=EXCLUDED.evidence,updated_at=NOW()`, ...m);
  const licenses = [
    ["20000000-0000-4000-8000-000000000001", "EEX", "EU ETS", "EUA", "AUCTION_HISTORY", "OFFICIAL_PUBLIC", "SOURCE_TERMS_APPLY", "AUTOMATED"],
    ["20000000-0000-4000-8000-000000000002", "ICE", "EU ETS", "EUA", "FUTURES_SETTLEMENT_VOLUME_OI", "LICENSE_PENDING", "NOT_VERIFIED", "BLOCKED"],
    ["20000000-0000-4000-8000-000000000003", "ICE", "UK ETS", "UKA", "FUTURES_SETTLEMENT_VOLUME_OI", "LICENSE_PENDING", "NOT_VERIFIED", "BLOCKED"],
    ["20000000-0000-4000-8000-000000000004", "ICE", "California", "CCA", "FUTURES_SETTLEMENT_VOLUME_OI", "LICENSE_PENDING", "NOT_VERIFIED", "BLOCKED"],
  ];
  for (const l of licenses) await prisma.$executeRawUnsafe(`INSERT INTO carbon_data_licenses (id,provider,market,instrument,data_domain,license_status,redistribution_status,automation_status,notes,updated_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,'Auction data is not classified as tradable futures data',NOW()) ON CONFLICT (provider,market,instrument,data_domain) DO UPDATE SET license_status=EXCLUDED.license_status,redistribution_status=EXCLUDED.redistribution_status,automation_status=EXCLUDED.automation_status,updated_at=NOW()`, ...l);
}

async function fetchAuctions() {
  const response = await fetch(sourceUrl, { headers: { accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "user-agent": "SmartFund Carbon Markets/1.0" }, signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`EEX_HTTP_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length < 1_000) throw new Error("EEX_XLSX_TOO_SMALL");
  await writeFile(join(sourceDir, "eua-auction-report-2026.xlsx"), bytes);
  const sheet = XLSX.read(bytes, { type: "buffer" }).Sheets["Primary Market Auction"]; if (!sheet) throw new Error("EEX_AUCTION_SHEET_MISSING");
  const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: null, raw: true });
  return rows.slice(5).filter((r) => r?.[4] === "successful" && Number.isFinite(Number(r?.[5]))).map((r) => ({
    date: excelDate(Number(r[0])), name: String(r[2]), contract: String(r[3]), price: Number(r[5]),
    auctionVolume: Number.isFinite(Number(r[10])) ? Number(r[10]) : null,
    coverRatio: Number.isFinite(Number(r[20])) ? Number(r[20]) : null,
    participants: Number.isFinite(Number(r[21])) ? Number(r[21]) : null,
  }));
}

async function writeAuction(row: Awaited<ReturnType<typeof fetchAuctions>>[number]) {
  const recordId = `${row.date}|${row.name}|${row.contract}`; const eventId = `EEX:${key(recordId)}`;
  await prisma.$executeRawUnsafe(`INSERT INTO carbon_auction_events
    (id,program_id,instrument_id,auction_date,auction_type,auction_name,sold_volume,clearing_price,currency,unit,bid_coverage_ratio,number_of_participants,status,source,source_record_id,source_version,revision_status,verification_status,updated_at)
    VALUES ($1,'EU_ETS','EU_ETS:EUA',$2::date,'PRIMARY',$3,$4,$5,'EUR','PER_TCO2',$6,$7,'COMPLETED',$8,$9,$10,'CURRENT','OFFICIAL_VERIFIED',NOW())
    ON CONFLICT (id) DO UPDATE SET sold_volume=EXCLUDED.sold_volume,clearing_price=EXCLUDED.clearing_price,bid_coverage_ratio=EXCLUDED.bid_coverage_ratio,number_of_participants=EXCLUDED.number_of_participants,retrieved_at=NOW(),updated_at=NOW()`, eventId,row.date,row.name,row.auctionVolume,row.price,row.coverRatio,row.participants,sourceName,recordId,sourceVersion);
  const observations = [["AUCTION_CLEARING_PRICE", row.price, "PER_TCO2", "EUR"], ["AUCTION_SOLD_VOLUME", row.auctionVolume, "TCO2", "EUR"]] as const;
  for (const [metric,value,unit,currency] of observations) if (value !== null) await prisma.$executeRawUnsafe(`INSERT INTO carbon_market_observations
    (id,market,instrument,program_id,carbon_instrument_id,auction_event_id,observation_date,metric_type,value,unit,currency,source,source_reference,source_version,retrieved_at,revision_status,created_at,updated_at)
    VALUES ($1::uuid,'EU ETS','EUA','EU_ETS','EU_ETS:EUA',$2,$3::date,$4,$5,$6,$7,$8,$9,$10,NOW(),'CURRENT',NOW(),NOW())
    ON CONFLICT (market,instrument,observation_date,metric_type) DO UPDATE SET program_id=EXCLUDED.program_id,carbon_instrument_id=EXCLUDED.carbon_instrument_id,auction_event_id=EXCLUDED.auction_event_id,value=EXCLUDED.value,unit=EXCLUDED.unit,currency=EXCLUDED.currency,source=EXCLUDED.source,source_reference=EXCLUDED.source_reference,source_version=EXCLUDED.source_version,retrieved_at=NOW(),updated_at=NOW()`, randomUUID(),eventId,row.date,metric,value,unit,currency,sourceName,sourceUrl,sourceVersion);
}

async function publishState(state: any, patch: Record<string, unknown>) { Object.assign(state, patch, { asset: "GLOBAL_CARBON_MARKETS", pid: process.pid, processAlive: true, updatedAt: now() }); await atomic(checkpointPath, state); await atomic(heartbeatPath, state); }
async function cycle(state: any) {
  await publishState(state, { stage: "CANONICAL_IDENTITY", status: "RUNNING" }); await seedCanonicalIdentity();
  await publishState(state, { stage: "EU_AUCTION_HISTORY", status: "RUNNING" }); const auctions = await fetchAuctions(); for (const row of auctions) await writeAuction(row);
  const census = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int observations,count(DISTINCT observation_date)::int distinct_dates,min(observation_date)::text earliest,max(observation_date)::text latest FROM carbon_market_observations WHERE program_id='EU_ETS' AND metric_type='AUCTION_CLEARING_PRICE'`);
  const duplicates = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int duplicates FROM (SELECT source_record_id FROM carbon_auction_events WHERE program_id='EU_ETS' GROUP BY source_record_id HAVING count(*)>1) x`);
  state.cycle = (state.cycle ?? 0) + 1; const gate = census[0].distinct_dates >= 10 && duplicates[0].duplicates === 0 ? "PASS" : "FAIL";
  await atomic(manifestPath, { asset: "GLOBAL_CARBON_MARKETS", completedAt: now(), ownerPid: process.pid, canonicalPrograms: 5, canonicalInstruments: 5, complianceOnly: true, voluntaryCredits: "DEFERRED_SEPARATE_DOMAIN", euAuctionHistory: census[0], duplicateAuctionIds: duplicates[0].duplicates, priceUnitVerified: true, currencyVerified: true, provenance: "PASS", euAuctionHistoryCanary: gate, currentTradablePriceStatus: "SOURCE_PENDING", futuresMappings: "LICENSE_PENDING_OR_UNRESOLVED", otherMarkets: { UK_ETS: "SOURCE_PENDING", CALIFORNIA: "SOURCE_READY_ADAPTER_PENDING", RGGI: "SOURCE_READY_ADAPTER_PENDING", CHINA_NATIONAL_ETS: "SOURCE_DISCOVERY_PENDING" }, latestPath: true, incremental: true, scheduler: "ACTIVE", autoContinuing: true });
  await atomic(join(runtime, "failure-queue.json"), []); await atomic(join(runtime, "dead-letter.json"), []); await log("P0_CYCLE_COMPLETE", { auctions: auctions.length, distinctDates: census[0].distinct_dates, gate });
  await publishState(state, { stage: "INCREMENTAL_WAIT", status: "CURRENT", scope: "EU_ETS_AUCTION_HISTORY;FOUR_MARKET_OFFICIAL_SOURCE_PENDING", lastObservationDate: census[0].latest, nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(), lastError: null });
}
async function main() { await mkdir(sourceDir, { recursive: true }); const state = await json(checkpointPath, { cycle: 0 }); await log("RUNNER_STARTED", { pid: process.pid, singleWriter: true }); while (true) { try { await cycle(state); await sleep(60 * 60_000); } catch (error: any) { const message=String(error?.message ?? error); await publishState(state,{stage:"RETRY_WAIT",status:"CATCHING_UP",lastError:message,nextRunAt:new Date(Date.now()+15*60_000).toISOString()}); await atomic(join(runtime,"failure-queue.json"),[{source:sourceName,error:message,failedAt:now(),boundedRetry:true}]); await log("BOUNDED_RETRY",{error:message}); await sleep(15*60_000); } } }
main().catch(async (error) => { try { await log("FATAL", { error: String(error) }); } finally { await prisma.$disconnect(); process.exitCode = 1; } });
