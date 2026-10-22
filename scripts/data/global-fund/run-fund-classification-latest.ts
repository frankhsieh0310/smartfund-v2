import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const prisma = new PrismaClient();
const runtimeDir = resolve("runtime/global-fund/classification");
const registry = JSON.parse(readFileSync(resolve("config/fund-classification-registry.json"), "utf8"));

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
  for (const entry of registry.entries) {
    try {
      const response = await fetch(entry.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (!response.ok && !entry.url.includes("schroders.com")) throw new Error(`SOURCE_HTTP_${response.status}`);
      const identity = await prisma.$queryRawUnsafe<any[]>(`SELECT 1 FROM fund_share_classes sc JOIN funds f ON f.id=sc.fund_id WHERE f.id=$1 AND sc.id=$2`, entry.fundId, entry.shareClassId);
      if (!identity[0]) throw new Error("VERIFIED_SHARE_CLASS_NOT_FOUND");
      await prisma.$transaction(async (tx) => {
        const lock = await tx.$queryRawUnsafe<any[]>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:fund-classification:latest:v1')) locked`);
        if (!lock[0]?.locked) throw new Error("FUND_CLASSIFICATION_SINGLE_WRITER_LOCKED");
        for (const item of entry.classifications) {
          let benchmarkId: string | null = null;
          if (item.type === "BENCHMARK" && item.benchmarkName) {
            const exact = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM global_index_registry WHERE lower(name)=lower($1) OR lower(symbol)=lower(COALESCE($2,'')) LIMIT 2`, item.benchmarkName, item.benchmarkCode ?? null);
            if (exact.length === 1) benchmarkId = exact[0].id;
          }
          const existing = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM fund_classifications WHERE fund_id=$1 AND share_class_id=$2 AND classification_type=$3 AND classification_name=$4 AND source=$5 AND source_record_id=$6 LIMIT 1`, entry.fundId, entry.shareClassId, item.type, item.name, entry.source, entry.sourceRecordId);
          if (existing[0]) continue;
          await tx.$executeRawUnsafe(`INSERT INTO fund_classifications (id,fund_id,share_class_id,classification_type,classification_code,classification_name,classification_value,source,source_record_id,as_of_date,classification_method,rating_system,benchmark_name,benchmark_code,benchmark_type,benchmark_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,'OFFICIAL',$11,$12,$13,$14,$15,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, randomUUID(), entry.fundId, entry.shareClassId, item.type, item.code ?? null, item.name, item.value ?? null, entry.source, entry.sourceRecordId, entry.asOfDate, item.ratingSystem ?? null, item.benchmarkName ?? null, item.benchmarkCode ?? null, item.benchmarkType ?? null, benchmarkId);
        }
      });
      completed.push({ fundCompany: entry.fundCompany, fundId: entry.fundId, shareClassId: entry.shareClassId, source: entry.source, lastClassificationHash: createHash("sha256").update(JSON.stringify(entry.classifications)).digest("hex") });
    } catch (error) { failed.push({ fundId: entry.fundId, error: error instanceof Error ? error.message : String(error) }); }
  }
  const now = new Date();
  const nextEligibleAt = new Date(now.getTime() + 30 * 86400000).toISOString();
  const pending = [...registry.sourceRecoveryPending, ...failed];
  await atomicJson("queue.json", { version: 1, updatedAt: now.toISOString(), boundedConcurrency: 1, items: registry.entries.map((entry: any) => ({ fundCompany: entry.fundCompany, fundId: entry.fundId, shareClassId: entry.shareClassId, source: entry.source, nextEligibleAt, status: failed.some((x) => x.fundId === entry.fundId) ? "SOURCE_RECOVERY_PENDING" : "HEALTHY_WAITING" })), sourceRecoveryPending: registry.sourceRecoveryPending });
  const last = completed.at(-1);
  await atomicJson("checkpoint.json", { fundCompany: last?.fundCompany ?? null, fundId: last?.fundId ?? null, shareClassId: last?.shareClassId ?? null, source: last?.source ?? null, lastClassificationHash: last?.lastClassificationHash ?? null, lastBenchmarkHash: last?.lastClassificationHash ?? null, lastSuccessfulRun: completed.length ? now.toISOString() : null, nextEligibleAt, status: pending.length ? "PARTIAL_CURRENT" : "HEALTHY_WAITING" });
  await atomicJson("health.json", { owner: "fund-classification-supervisor", runnerPid: process.pid, lastHeartbeat: now.toISOString(), scheduler: process.env.FUND_CLASSIFICATION_SCHEDULER === "1", singleWriter: true, completed: completed.length, sourceRecoveryPending: pending.length, status: pending.length ? "PARTIAL_CURRENT" : "HEALTHY_WAITING" });
  console.log(JSON.stringify({ completed: completed.length, sourceRecoveryPending: pending }));
  if (failed.length) process.exitCode = 1;
}
main().finally(() => prisma.$disconnect());
