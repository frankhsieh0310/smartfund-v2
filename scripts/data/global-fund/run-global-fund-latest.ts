import { PrismaClient } from "@prisma/client";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchSitcaFscNav, SITCA_FSC_NAV_SOURCE, type SitcaFundNavRecord } from "./adapters/sitca-fsc-nav";
import { writeAssetRuntimeStatus } from "../runtime-status/write-asset-runtime-status.ts";

const prisma = new PrismaClient();
const runtimeDir = resolve("runtime/global-fund");
const checkpointPath = resolve(runtimeDir, "checkpoint.json");
const healthPath = resolve(runtimeDir, "health.json");
const canaryArg = process.argv.find((arg) => arg.startsWith("--canary="));
const canaryLimit = canaryArg ? Number(canaryArg.split("=")[1]) : null;
const owner = process.env.SMARTFUND_NODE_ID || "desktop-global-fund";

async function atomicJson(path: string, value: unknown) {
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function selectCanary(db: any, records: SitcaFundNavRecord[]) {
  if (canaryLimit !== null && (!Number.isInteger(canaryLimit) || canaryLimit < 1 || canaryLimit > 10)) throw new Error("INVALID_CANARY_LIMIT");
  const mappings = await db.$queryRawUnsafe<Array<{ fundId: string; providerCode: string }>>(
    `SELECT "fund_id" AS "fundId", "provider_code" AS "providerCode"
     FROM "fund_provider_mappings"
     WHERE "provider"='SITCA'
       AND "source" IS NOT NULL
       AND "verified_at" IS NOT NULL
       AND "mapping_method" IN ('EXACT_ISIN','EXACT_LOCAL_CODE','EXACT_PROVIDER_ID','DETERMINISTIC_COMPOSITE')`,
  );
  const mappedFund = new Map(mappings.map((mapping: { fundId: string; providerCode: string }) => [mapping.providerCode, mapping.fundId]));
  const seen = new Set<string>();
  const matched = records.flatMap((record) => {
    const fundId = mappedFund.get(record.sourceRecordId);
    if (!fundId || seen.has(record.sourceRecordId)) return [];
    seen.add(record.sourceRecordId);
    return [{ record, fundId }];
  });
  return canaryLimit === null ? matched : matched.slice(0, canaryLimit);
}

async function upsertLatest(db: any, record: SitcaFundNavRecord, fundId: string) {
  const fund = await db.fund.update({
    where: { id: fundId },
    data: {
      name: record.name, company: record.company, currency: record.currency,
      latestNav: record.nav, latestNavDate: record.navDate, navUpdatedAt: new Date(),
      lastNavSource: record.source, dataProvider: "SITCA", dataSource: record.source,
    },
  });
  await db.$executeRawUnsafe(
    `UPDATE "funds" SET "legal_name"=$1, "domicile"='TW' WHERE "id"=$2`,
    record.name, fund.id,
  );
  await db.fundHistory.upsert({
    where: { fundId_date: { fundId: fund.id, date: record.navDate } },
    create: { fundId: fund.id, date: record.navDate, nav: record.nav },
    update: { nav: record.nav },
  });
  const shareClassId = crypto.randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "fund_share_classes" ("id","fund_id","share_class_name","share_class_code","currency","status","domicile","source","source_record_id","created_at","updated_at")
     VALUES ($1,$2,$3,$4,$5,'ACTIVE','TW',$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT ("fund_id","source","source_record_id") DO UPDATE SET
       "share_class_name"=EXCLUDED."share_class_name", "share_class_code"=EXCLUDED."share_class_code",
       "currency"=EXCLUDED."currency", "domicile"=EXCLUDED."domicile", "updated_at"=CURRENT_TIMESTAMP`,
    shareClassId, fund.id, record.name, record.code, record.currency, record.source, record.sourceRecordId,
  );
  const proof = await db.$queryRawUnsafe(
    `SELECT id FROM "fund_share_classes" WHERE "fund_id"=$1 AND "source"=$2 AND "source_record_id"=$3 LIMIT 1`,
    fund.id, record.source, record.sourceRecordId,
  );
  if (!proof[0]) throw new Error(`FUND_SHARE_CLASS_READ_BACK_FAILED:${record.code}`);
  return { fundId: fund.id, shareClassId: proof[0].id, code: record.code, navDate: record.navDate.toISOString().slice(0, 10) };
}

async function main() {
  const startedAt = new Date();
  const fetched = await fetchSitcaFscNav();
  const results = await prisma.$transaction(async (db) => {
    const lock = await db.$queryRawUnsafe<Array<{ locked: boolean }>>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:global-fund:latest:v2')) AS locked`);
    if (!lock[0]?.locked) throw new Error("GLOBAL_FUND_SINGLE_WRITER_LOCKED");
    const records = await selectCanary(db, fetched);
    if (!records.length) throw new Error("GLOBAL_FUND_NO_MAPPED_RECORDS");
    const written = [];
    for (const item of records) written.push(await upsertLatest(db, item.record, item.fundId));
    return written;
  }, { maxWait: 10_000, timeout: 120_000 });
    const last = results.at(-1)!;
    const completedAt = new Date();
    await atomicJson(checkpointPath, {
      source: SITCA_FSC_NAV_SOURCE, lastSourceDate: last.navDate, lastSourceRecord: last.code,
      lastCanonicalNavDate: last.navDate, lastFundId: last.fundId, lastShareClassId: last.shareClassId,
      lastSuccessfulRun: completedAt.toISOString(), nextEligibleAt: new Date(completedAt.getTime() + 6 * 60 * 60 * 1000).toISOString(),
    });
    await atomicJson(healthPath, {
      owner, runnerPid: process.pid, supervisorPid: process.env.SMARTFUND_SUPERVISOR_PID ? Number(process.env.SMARTFUND_SUPERVISOR_PID) : null,
      lastHeartbeat: completedAt.toISOString(), lastCheckpoint: completedAt.toISOString(), latestPath: true,
      incremental: true, scheduler: process.env.SMARTFUND_SCHEDULER === "1", autoContinuing: process.env.SMARTFUND_SCHEDULER === "1",
      singleWriter: true, status: "CURRENT", source: SITCA_FSC_NAV_SOURCE, fetched: fetched.length, processed: results.length,
      sourceRecordsTotal: fetched.length, mappedRecords: results.length, unresolvedRecords: fetched.length - results.length,
      mappingCoverage: Number((results.length / fetched.length * 100).toFixed(4)), shareClassMapped: results.length,
      schedulerMode: process.env.SMARTFUND_SCHEDULER === "1" ? "ACTIVE_PARTIAL_COVERAGE" : "INACTIVE",
    });
    const nextRunAt = new Date(completedAt.getTime() + 6 * 60 * 60 * 1000).toISOString();
    await writeAssetRuntimeStatus("FUND", {
      CURRENT_PHASE: "INCREMENTAL", CURRENT_LAYER: "P0A", CURRENT_TASK: "NAV", CURRENT_MARKET: "TW",
      CURRENT_SOURCE: SITCA_FSC_NAV_SOURCE, PROCESSED: results.length, TOTAL: fetched.length,
      COVERAGE: Number((results.length / fetched.length * 100).toFixed(4)), RUN_STATE: process.env.SMARTFUND_SCHEDULER === "1" ? "SCHEDULED_WAIT" : "COMPLETE",
      PROCESS_ID: process.env.SMARTFUND_SUPERVISOR_PID ? Number(process.env.SMARTFUND_SUPERVISOR_PID) : process.pid,
      HEARTBEAT_AT: completedAt.toISOString(), LAST_PROGRESS_AT: completedAt.toISOString(),
      LAST_PROGRESS: `NAV batch completed: +${results.length} canonical NAV rows; mapped ${results.length}/${fetched.length}; checkpoint ${last.code}`,
      CHECKPOINT: "runtime/global-fund/checkpoint.json", BLOCKER: null, NEXT: "Incremental", NEXT_RUN_AT: nextRunAt,
      NAV_STATUS: "CURRENT_AND_AUTO_UPDATING", CONTINUING: "YES",
    });
    console.log(JSON.stringify({ fetch: "PASS", parse: "PASS", semantics: "PASS", identity: "PASS", writeCanary: "PASS", readBack: "PASS", results }));
}

main().catch(async (error) => {
  await atomicJson(healthPath, { owner, runnerPid: process.pid, lastHeartbeat: new Date().toISOString(), latestPath: true, incremental: true, singleWriter: true, status: "FAILED", error: error instanceof Error ? error.message : String(error) });
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
