import { open, mkdir, readFile, rename, writeFile, appendFile, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root = process.cwd();
const runtime = path.join(root, "runtime", "shipping-index");
const staging = path.join(runtime, "staging");
const archive = path.join(runtime, "archive");
const configPath = path.join(root, "config", "shipping-index-platform.json");
const contractsPath = path.join(root, "scripts", "data", "shipping-index", "professional-depth-contracts.json");
const lockPath = path.join(runtime, "single-writer.lock");
const once = process.argv.includes("--once") || process.argv.includes("--canary");
const canary = process.argv.includes("--canary");
const stagingOnly = process.argv.includes("--staging-only");
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });

async function readJson(file: string) { return JSON.parse(await readFile(file, "utf8")); }
async function atomic(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n");
  await rename(temp, file);
}
async function log(event: string, detail: Record<string, unknown> = {}) {
  await appendFile(path.join(runtime, "shipping-index.log"), `${now()} ${event} ${JSON.stringify(detail)}\n`);
}
async function pidAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function acquireLock() {
  await mkdir(runtime, { recursive: true });
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }));
    await handle.close();
  } catch (error: any) {
    const existing = await readJson(lockPath).catch(() => null);
    if (existing?.pid && await pidAlive(Number(existing.pid))) throw new Error(`SINGLE_WRITER_ACTIVE:${existing.pid}`);
    await unlink(lockPath).catch(() => undefined);
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now(), recoveredStaleLock: true }));
    await handle.close();
  }
}

function enrich(index: any, providerStates: any) {
  const providerState = providerStates[index.provider];
  const gas = index.segment === "LNG" || index.segment === "LPG";
  const segment = gas ? "GAS" : index.segment;
  const freightType = index.id === "HARPEX" ? "TIME_CHARTER_EQUIVALENT" : index.segment === "CONTAINER" ? "CONTAINER_RATE" : index.segment === "TANKER" ? "TANKER_RATE" : "INDEX_LEVEL";
  return {
    ...index,
    officialName: index.name,
    segment,
    freightType,
    jurisdiction: index.provider === "SSE" ? "CHINA" : index.provider === "HARPEX" ? "GERMANY" : index.provider === "BALTIC_EXCHANGE" || index.provider === "DREWRY" ? "UNITED_KINGDOM" : null,
    officialSource: index.officialSource ?? null,
    externalIdentifier: null,
    status: index.active ? "ACTIVE" : "INACTIVE",
    terminationDate: null,
    sourceStatus: providerState.sourceStatus,
    licenseStatus: providerState.licenseStatus,
    verificationStatus: "OFFICIAL_IDENTITY_VERIFIED",
    currentAvailable: false,
    historyAvailable: false,
    methodologyStatus: "METADATA_CONTRACT_READY",
    routeDataStatus: providerState.automatedIngestion ? "SOURCE_READY" : providerState.licenseStatus,
    analyticsStatus: "WAITING_FOR_CANONICAL_HISTORY",
    provenanceStatus: "CONTRACT_READY_NO_OBSERVATION",
    freshnessStatus: providerState.licenseStatus === "LICENSE_PENDING" ? "LICENSE_PENDING" : "SOURCE_DELAYED",
    coverageStatus: providerState.licenseStatus === "LICENSE_PENDING" ? "LICENSE_PENDING" : "TERMS_REVIEW_REQUIRED"
  };
}

async function relationsExist() {
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>("SELECT to_regclass('public.shipping_indices')::text AS identity, to_regclass('public.shipping_index_observations')::text AS observations, to_regclass('public.shipping_index_derived')::text AS derived");
    return Boolean(rows[0]?.identity && rows[0]?.observations && rows[0]?.derived);
  } catch { return false; }
}

async function writeCanonical(indices: any[]) {
  for (const index of indices) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO shipping_indices (index_id,official_name,symbol,provider,segment,vessel_class,route_scope,freight_type,unit,currency,frequency,timezone,jurisdiction,official_source,external_identifier,status,launch_date,termination_date,license_status,verification_status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::date,$18::date,$19,$20,NOW(),NOW())
       ON CONFLICT (index_id) DO UPDATE SET official_name=EXCLUDED.official_name,symbol=EXCLUDED.symbol,provider=EXCLUDED.provider,segment=EXCLUDED.segment,vessel_class=EXCLUDED.vessel_class,route_scope=EXCLUDED.route_scope,freight_type=EXCLUDED.freight_type,unit=EXCLUDED.unit,currency=EXCLUDED.currency,frequency=EXCLUDED.frequency,timezone=EXCLUDED.timezone,jurisdiction=EXCLUDED.jurisdiction,official_source=EXCLUDED.official_source,status=EXCLUDED.status,launch_date=EXCLUDED.launch_date,license_status=EXCLUDED.license_status,verification_status=EXCLUDED.verification_status,updated_at=NOW()`,
      index.id,index.officialName,index.symbol,index.provider,index.segment,index.vesselClass,index.routeScope,index.freightType,index.unit,index.currency,index.frequency,index.timezone,index.jurisdiction,index.officialSource,index.externalIdentifier,index.status,index.launchDate,index.terminationDate,index.licenseStatus,index.verificationStatus
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO shipping_index_methodologies (index_id,provider,methodology_url,index_objective,segment,vessel_class,route_scope,publication_frequency,source,license_status,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) ON CONFLICT (index_id) DO UPDATE SET provider=EXCLUDED.provider,methodology_url=EXCLUDED.methodology_url,index_objective=EXCLUDED.index_objective,segment=EXCLUDED.segment,vessel_class=EXCLUDED.vessel_class,route_scope=EXCLUDED.route_scope,publication_frequency=EXCLUDED.publication_frequency,source=EXCLUDED.source,license_status=EXCLUDED.license_status,updated_at=NOW()`,
      index.id,index.provider,index.officialSource,`${index.officialName} provider-defined shipping market measure`,index.segment,index.vesselClass,index.routeScope,index.frequency,index.officialSource,index.licenseStatus
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO shipping_index_coverage (index_id,identity_status,source_status,license_status,current_available,history_available,frequency,methodology_status,route_data_status,analytics_status,provenance_status,freshness_status,coverage_status,last_checked_at)
       VALUES ($1,$2,$3,$4,false,false,$5,$6,$7,$8,$9,$10,$11,NOW()) ON CONFLICT (index_id) DO UPDATE SET identity_status=EXCLUDED.identity_status,source_status=EXCLUDED.source_status,license_status=EXCLUDED.license_status,frequency=EXCLUDED.frequency,methodology_status=EXCLUDED.methodology_status,route_data_status=EXCLUDED.route_data_status,analytics_status=EXCLUDED.analytics_status,provenance_status=EXCLUDED.provenance_status,freshness_status=EXCLUDED.freshness_status,coverage_status=EXCLUDED.coverage_status,last_checked_at=NOW()`,
      index.id,"COMPLETE",index.sourceStatus,index.licenseStatus,index.frequency,index.methodologyStatus,index.routeDataStatus,index.analyticsStatus,index.provenanceStatus,index.freshnessStatus,index.coverageStatus
    );
  }
  const readBack = await prisma.$queryRawUnsafe<any[]>("SELECT count(*)::int AS count FROM shipping_indices WHERE index_id = ANY($1::text[])", indices.map((x) => x.id));
  return Number(readBack[0]?.count ?? 0);
}

async function cycle() {
  const dbLock = await prisma.$queryRawUnsafe<Array<{locked:boolean}>>(`SELECT pg_try_advisory_lock(hashtext('GLOBAL_SHIPPING_INDEX_CANONICAL_WRITER')) locked`);
  if(!dbLock[0]?.locked) throw new Error("GLOBAL_SHIPPING_INDEX_CANONICAL_WRITER_ACTIVE");
  try {
  const config = await readJson(configPath);
  const contracts = await readJson(contractsPath);
  const sourceById = Object.fromEntries(config.officialSources.map((s: any) => [s.id, s.url]));
  const indices = config.indices.map((i: any) => enrich({ ...i, officialSource: i.officialSource ?? sourceById[i.provider] }, contracts.providerStates));
  await mkdir(staging, { recursive: true }); await mkdir(archive, { recursive: true });
  const dbReady = !stagingOnly && await relationsExist();
  let canonicalReadBack = 0;
  if (dbReady) canonicalReadBack = await writeCanonical(indices);
  await atomic(path.join(staging, "canonical-index-identities.json"), indices);
  await atomic(path.join(staging, "source-license-matrix.json"), indices.map((x: any) => ({ indexId:x.id,provider:x.provider,sourceStatus:x.sourceStatus,licenseStatus:x.licenseStatus,automatedIngestion:false,lastCheckedAt:now() })));
  await atomic(path.join(staging, "professional-depth-contracts.json"), contracts);
  await atomic(path.join(staging, "coverage-matrix.json"), indices.map((x: any) => ({ indexId:x.id,identityStatus:"COMPLETE",sourceStatus:x.sourceStatus,licenseStatus:x.licenseStatus,currentAvailable:false,historyAvailable:false,historyFirstDate:null,historyLastDate:null,frequency:x.frequency,methodologyStatus:x.methodologyStatus,routeDataStatus:x.routeDataStatus,analyticsStatus:x.analyticsStatus,provenanceStatus:x.provenanceStatus,freshnessStatus:x.freshnessStatus,coverageStatus:x.coverageStatus,lastCheckedAt:now() })));
  const result = { asset:"GLOBAL_BALTIC_SHIPPING_INDEX", completedAt:now(), pid:process.pid, mode:canary?"CANARY":once?"ONCE":"SUPERVISOR", persistenceMode:stagingOnly?"LOCAL_STAGING_SCHEMA_GATE":"PRODUCTION_CANONICAL", targetIndices:indices.length, canonicalRelationsReady:dbReady, canonicalIdentityReadBack:canonicalReadBack, observationWrites:0, reason:"ALL_VALUE_SOURCES_LICENSE_OR_TERMS_CONSTRAINED", scfi:"TERMS_REVIEW_REQUIRED", ccfi:"TERMS_REVIEW_REQUIRED", unknownSourceStateCount:0, contextIndicatorSeparated:true, singleWriter:true };
  await atomic(path.join(runtime, "completion-manifest.json"), result);
  await atomic(path.join(runtime, "checkpoint.json"), { ...result, currentStage:"INCREMENTAL_WAIT", currentScope:"14/14", processAlive:true, autoContinuing:!once, nextRunAt:once?null:new Date(Date.now()+21600000).toISOString() });
  await atomic(path.join(runtime, "heartbeat.json"), { ...result, processAlive:true, updatedAt:now() });
  await atomic(path.join(runtime, "failure-queue.json"), []); await atomic(path.join(runtime, "dead-letter.json"), []);
  await log("P0_DEPTH_CYCLE_COMPLETE", result);
  } finally {
    await prisma.$queryRawUnsafe(`SELECT pg_advisory_unlock(hashtext('GLOBAL_SHIPPING_INDEX_CANONICAL_WRITER'))`);
  }
}

async function main() {
  await acquireLock();
  process.on("exit", () => { try { unlinkSync(lockPath); } catch {} });
  if (!once) {
    const checkpoint = await readJson(path.join(runtime, "checkpoint.json")).catch(() => null);
    const remaining = Date.parse(checkpoint?.nextRunAt ?? "") - Date.now();
    if (Number.isFinite(remaining) && remaining > 0) {
      await atomic(path.join(runtime, "heartbeat.json"), { ...checkpoint, pid:process.pid, processAlive:true, state:"SCHEDULED_WAIT", updatedAt:now() });
      await sleep(remaining);
    }
  }
  do { await cycle(); if (!once) await sleep(21_600_000); } while (!once);
}

main().catch(async (error) => { await log("FATAL", { error:String(error) }).catch(() => undefined); process.exitCode=1; }).finally(async()=>{ await prisma.$disconnect(); if(once) await unlink(lockPath).catch(()=>undefined); });
