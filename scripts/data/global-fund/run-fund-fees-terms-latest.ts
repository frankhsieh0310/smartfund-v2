import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const prisma = new PrismaClient();
const runtimeDir = resolve("runtime/global-fund/fees-terms");
const registry = JSON.parse(readFileSync(resolve("config/fund-fees-terms-registry.json"), "utf8")) as { terms: any[] };

async function atomicJson(name: string, value: unknown) {
  await mkdir(runtimeDir, { recursive: true });
  const path = resolve(runtimeDir, name);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
  const completed: any[] = [];
  const failed: any[] = [];
  for (const terms of registry.terms) {
    const hash = createHash("sha256").update(JSON.stringify(terms)).digest("hex");
    try {
      const response = await fetch(terms.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (!response.ok && !terms.url.includes("schroders.com")) throw new Error(`TERMS_HTTP_${response.status}`);
      const current = await prisma.$queryRawUnsafe<Array<any>>(`SELECT management_fee::text,distribution_frequency,accumulating_distributing,share_class_type,terms_source,terms_source_record_id,terms_as_of_date::text FROM fund_share_classes WHERE id=$1 AND fund_id=$2`, terms.shareClassId, terms.fundId);
      if (!current[0]) throw new Error("TERMS_SHARE_CLASS_NOT_FOUND");
      const row = current[0];
      const same = (terms.managementFee == null || Number(row.management_fee) === Number(terms.managementFee)) && (terms.distributionFrequency == null || row.distribution_frequency === terms.distributionFrequency) && (terms.accumulatingDistributing == null || row.accumulating_distributing === terms.accumulatingDistributing) && row.share_class_type === terms.shareClassType && row.terms_source_record_id === terms.sourceRecordId;
      if (!same) await prisma.$transaction(async (tx) => {
        const lock = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:fund-fees-terms:latest:v1')) locked`);
        if (!lock[0]?.locked) throw new Error("FUND_FEES_TERMS_SINGLE_WRITER_LOCKED");
        await tx.$executeRawUnsafe(`UPDATE fund_share_classes SET management_fee=COALESCE($2::numeric,management_fee),distribution_frequency=COALESCE($3,distribution_frequency),accumulating_distributing=COALESCE($4,accumulating_distributing),share_class_type=COALESCE($5,share_class_type),terms_source=$6,terms_source_record_id=$7,terms_as_of_date=COALESCE($8::date,terms_as_of_date),updated_at=CURRENT_TIMESTAMP WHERE id=$1`, terms.shareClassId, terms.managementFee, terms.distributionFrequency, terms.accumulatingDistributing, terms.shareClassType, terms.source, terms.sourceRecordId, terms.asOfDate);
      });
      completed.push({ ...terms, lastTermsHash: hash, action: same ? "SKIP_CURRENT" : "UPDATE_TERMS" });
    } catch (error) { failed.push({ shareClassId: terms.shareClassId, error: error instanceof Error ? error.message : String(error) }); }
  }
  const now = new Date();
  const nextEligibleAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await atomicJson("queue.json", { version: 1, updatedAt: now.toISOString(), active: true, boundedConcurrency: 1, items: registry.terms.map((terms) => { const done = completed.find((item) => item.shareClassId === terms.shareClassId); return { fundCompany: terms.fundCompany, fundId: terms.fundId, shareClassId: terms.shareClassId, source: terms.source, lastSourceRecord: terms.sourceRecordId, lastTermsHash: done?.lastTermsHash ?? null, nextEligibleAt, status: failed.some((item) => item.shareClassId === terms.shareClassId) ? "SOURCE_RECOVERY_PENDING" : "HEALTHY_WAITING" }; }) });
  const last = completed.at(-1);
  await atomicJson("checkpoint.json", { fundCompany: last?.fundCompany ?? null, fundId: last?.fundId ?? null, shareClassId: last?.shareClassId ?? null, source: last?.source ?? null, lastSourceRecord: last?.sourceRecordId ?? null, lastTermsHash: last?.lastTermsHash ?? null, lastSuccessfulRun: completed.length ? now.toISOString() : null, nextEligibleAt, status: failed.length ? "PARTIAL_CURRENT" : "HEALTHY_WAITING" });
  await atomicJson("health.json", { owner: "fund-fees-terms-supervisor", runnerPid: process.pid, lastHeartbeat: now.toISOString(), latestPath: true, incremental: true, scheduler: process.env.FUND_FEES_TERMS_SCHEDULER === "1", autoContinuing: process.env.FUND_FEES_TERMS_SCHEDULER === "1", singleWriter: true, completed: completed.length, failed: failed.length, status: failed.length ? "PARTIAL_CURRENT" : "HEALTHY_WAITING" });
  console.log(JSON.stringify({ completed: completed.length, failed }));
  if (failed.length) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
