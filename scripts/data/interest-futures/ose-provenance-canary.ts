import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = process.cwd();
const prisma = new PrismaClient();
const SOURCE = "JPX_OSE_OFFICIAL_SETTLEMENT_CSV";
const PARSER_VERSION = "LEGACY_PARSER_VERSION_UNAVAILABLE";
const SOURCE_RECORD_ID_TYPE = "DERIVED_DETERMINISTIC_SOURCE_GRAIN";
const CHECKSUM_TYPE = "PLATFORM_DERIVED_SHA256";

function assert(condition, message) { if (!condition) throw new Error(message); }
function checksum(row) {
  const payload = JSON.stringify({ source: row.source, sourceUrl: row.sourceUrl, contractCode: row.contractCode, observedAt: row.observationTimestamp, settlement: row.settlementPrice, expiration: row.expirationDate });
  return `${CHECKSUM_TYPE}:${createHash("sha256").update(payload).digest("hex")}`;
}
function sourceRecordId(row) {
  return `${SOURCE_RECORD_ID_TYPE}:JPX_OSE:${row.contractCode}:${row.settlementDate}`;
}
async function countRows(contractId) {
  const rows = await prisma.$queryRawUnsafe("SELECT COUNT(*)::int AS count FROM futures_observations WHERE contract_id=$1::uuid", contractId);
  return rows[0].count;
}
async function writeRows(contractId, rows) {
  const representative = rows.at(-1);
  await prisma.$executeRawUnsafe(
    "UPDATE futures_contracts SET source_url=$1, verification_status='VERIFIED', status='ACTIVE', updated_at=NOW() WHERE id=$2::uuid",
    representative.sourceUrl, contractId,
  );
  for (const row of rows) {
    assert(row.source === SOURCE, "SOURCE_MISMATCH");
    assert(row.observationType === "SETTLEMENT", "OBSERVATION_TYPE_NOT_SETTLEMENT");
    assert(Number.isFinite(row.settlementPrice) && row.settlementPrice > 0 && row.settlementPrice < 200, "INVALID_SETTLEMENT");
    assert(new Date(row.observationTimestamp) <= new Date(), "FUTURE_OBSERVATION");
    assert(new Date(row.expirationDate) > new Date(row.observationTimestamp), "INVALID_EXPIRATION");
    assert(row.sourceUrl?.startsWith("https://www.jpx.co.jp/"), "INVALID_OFFICIAL_SOURCE_URL");
    assert(row.ingestedAt && new Date(row.ingestedAt) > new Date(row.observationTimestamp), "INVALID_RETRIEVED_AT_LINEAGE");
    const key = `${SOURCE}:${row.contractCode}:${row.observationTimestamp}`;
    await prisma.$executeRawUnsafe(
      `UPDATE futures_observations SET
         settlement=$1, source_record_id=$2, source_url=$3, verification_status='VERIFIED',
         quality_status='OFFICIAL_DAILY_SETTLEMENT', freshness_status=$4, retrieved_at=$5,
         parser_version=$6, source_checksum=$7, license_status='PUBLIC', updated_at=NOW()
       WHERE contract_id=$8::uuid AND source_key=$9`,
      row.settlementPrice, sourceRecordId(row), row.sourceUrl, row.freshnessStatus,
      new Date(row.ingestedAt), PARSER_VERSION, checksum(row), contractId, key,
    );
  }
}
async function readBack(contractId) {
  return prisma.$queryRawUnsafe(
    `SELECT observed_at, settlement, source, source_key, source_record_id, source_url,
            verification_status, quality_status, freshness_status, retrieved_at,
            parser_version, source_checksum, license_status
     FROM futures_observations WHERE contract_id=$1::uuid ORDER BY observed_at`,
    contractId,
  );
}

let advisoryLock = false;
try {
  const checkpoint = JSON.parse(await readFile(join(ROOT, "runtime", "interest-futures", "checkpoint.json"), "utf8"));
  const owner = JSON.parse(await readFile(join(ROOT, "runtime", "interest-futures", "runner.lock"), "utf8"));
  assert(checkpoint.pid === owner.pid, "SINGLE_WRITER_OWNER_MISMATCH");
  assert(checkpoint.currentStage === "SCHEDULED_INCREMENTAL", "SUPERVISOR_NOT_IN_DORMANT_SCHEDULE_WINDOW");
  assert(new Date(checkpoint.nextRunAt).getTime() - Date.now() > 60_000, "SCHEDULE_WINDOW_TOO_SHORT");
  try { process.kill(owner.pid, 0); } catch { throw new Error("SUPERVISOR_NOT_ALIVE"); }

  const lock = await prisma.$queryRawUnsafe("SELECT pg_try_advisory_lock(hashtext('smartfund:interest-futures:ose-provenance-canary')) AS acquired");
  advisoryLock = Boolean(lock[0]?.acquired);
  assert(advisoryLock, "DB_ADVISORY_LEASE_NOT_ACQUIRED");

  const rows = (await readFile(join(ROOT, "runtime", "interest-futures", "data", "OSE_TONA_3M.ndjson"), "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert(rows.length === 2, "OSE_CANARY_REQUIRES_TWO_CANONICAL_ROWS");
  const contracts = await prisma.$queryRawUnsafe("SELECT id, contract_symbol, expiration, status FROM futures_contracts WHERE asset_class='INTEREST_RATE_FUTURES' AND exchange='OSE' AND root_symbol='TOA3M' LIMIT 2");
  assert(contracts.length === 1, "OSE_CANONICAL_CONTRACT_COUNT_NOT_ONE");
  assert(contracts[0].contract_symbol === rows[0].contractCode, "CONTRACT_IDENTITY_MISMATCH");
  const contractId = contracts[0].id;
  const before = await countRows(contractId);
  await writeRows(contractId, rows);
  const afterFirstWrite = await countRows(contractId);
  const firstRead = await readBack(contractId);
  assert(firstRead.length === rows.length, "READ_BACK_COUNT_MISMATCH");
  assert(firstRead.every((row) => row.source_record_id?.startsWith(`${SOURCE_RECORD_ID_TYPE}:`) && row.source_url && row.retrieved_at && row.source_checksum?.startsWith(`${CHECKSUM_TYPE}:`) && row.parser_version === PARSER_VERSION && row.verification_status === "VERIFIED" && row.freshness_status !== "UNKNOWN"), "PROVENANCE_READ_BACK_FAILED");
  const stableState = JSON.stringify(firstRead, (_, value) => typeof value === "bigint" ? Number(value) : value);
  await writeRows(contractId, rows);
  const afterReplay = await countRows(contractId);
  const secondRead = await readBack(contractId);
  const replayState = JSON.stringify(secondRead, (_, value) => typeof value === "bigint" ? Number(value) : value);
  const duplicateGroups = await prisma.$queryRawUnsafe("SELECT COUNT(*)::int AS count FROM (SELECT source_key FROM futures_observations WHERE contract_id=$1::uuid GROUP BY source_key HAVING COUNT(*)>1) d", contractId);
  console.log(JSON.stringify({ status: "PASS", supervisorPid: owner.pid, before, afterFirstWrite, afterReplay, newDuplicateRows: afterReplay - afterFirstWrite, duplicateGroups: duplicateGroups[0].count, stateDrift: stableState === replayState ? 0 : 1, contractRows: contracts.length, observationRows: secondRead.length, provenanceRows: secondRead.filter((row) => row.source_url && row.source_record_id && row.retrieved_at && row.source_checksum && row.parser_version && row.verification_status).length }));
} catch (error) {
  console.log(JSON.stringify({ status: "FAIL", error: error?.message || String(error) }));
  process.exitCode = 1;
} finally {
  if (advisoryLock) await prisma.$queryRawUnsafe("SELECT pg_advisory_unlock(hashtext('smartfund:interest-futures:ose-provenance-canary'))").catch(() => {});
  await prisma.$disconnect();
}
