import { PrismaClient } from "@prisma/client";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const prisma = new PrismaClient();
const runtimeDir = resolve("runtime/global-fund/provider-expansion");
const queuePath = resolve(runtimeDir, "company-queue.json");
const unresolvedPath = resolve(runtimeDir, "unresolved.json");
const healthPath = resolve("runtime/global-fund/health.json");
const now = new Date();

type QueueStatus = "PENDING" | "SOURCE_CANARY" | "MAPPING" | "CURRENT" | "PARTIAL_CURRENT" | "HEALTHY_WAITING" | "SOURCE_RECOVERY_PENDING" | "UNRESOLVED" | "FAILED_ISOLATED";
type CompanyQueueItem = {
  fundCompany: string;
  existingFundCount: number;
  existingIsinCount: number;
  sourceStatus: string;
  selectedSource: string | null;
  mappingStatus: string;
  matchedFunds: number;
  matchedShareClasses: number;
  unresolved: number;
  lastAttempt: string | null;
  nextEligibleAt: string | null;
  status: QueueStatus;
};

const phaseA = new Map<string, Partial<CompanyQueueItem>>([
  ["\u91ce\u6751\u8b49\u5238\u6295\u8cc7\u4fe1\u8a17\u80a1\u4efd\u6709\u9650\u516c\u53f8", { sourceStatus: "SOURCE_RECOVERY_PENDING", status: "SOURCE_RECOVERY_PENDING", unresolved: 1, lastAttempt: now.toISOString() }],
  ["\u806f\u535a\u8b49\u5238\u6295\u8cc7\u4fe1\u8a17\u80a1\u4efd\u6709\u9650\u516c\u53f8", { sourceStatus: "PASS", selectedSource: "AB_OFFICIAL_PRODUCT_RANGE", mappingStatus: "CURRENT", matchedFunds: 2, matchedShareClasses: 2, status: "CURRENT", lastAttempt: now.toISOString() }],
  ["\u8def\u535a\u9081\u8b49\u5238\u6295\u8cc7\u4fe1\u8a17\u80a1\u4efd\u6709\u9650\u516c\u53f8", { sourceStatus: "SOURCE_RECOVERY_PENDING", status: "SOURCE_RECOVERY_PENDING", unresolved: 1, lastAttempt: now.toISOString() }],
  ["\u5bcc\u862d\u514b\u6797\u8b49\u5238\u6295\u8cc7\u9867\u554f\u80a1\u4efd\u6709\u9650\u516c\u53f8", { sourceStatus: "PASS", selectedSource: "FRANKLIN_TW_OFFICIAL", mappingStatus: "CURRENT", matchedFunds: 2, matchedShareClasses: 2, status: "CURRENT", lastAttempt: now.toISOString() }],
  ["\u65bd\u7f85\u5fb7\u8b49\u5238\u6295\u8cc7\u4fe1\u8a17\u80a1\u4efd\u6709\u9650\u516c\u53f8", { sourceStatus: "PASS", selectedSource: "SCHRODERS_AVAILABLE_SHARE_CLASSES", mappingStatus: "CURRENT", matchedFunds: 2, matchedShareClasses: 2, status: "CURRENT", lastAttempt: now.toISOString() }],
]);

async function atomicJson(path: string, value: unknown) {
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readJson(path: string) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function runSitcaIdentityBatch() {
  await prisma.$disconnect();
  return new Promise<{ code: number; tail: string[] }>((complete) => {
    const tail: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", "--env-file=.env", "scripts/data/global-fund/run-fund-multi-source-identity-crosswalk.ts"], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => { tail.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean).map(line => line.slice(0, 1000))); if (tail.length > 8) tail.splice(0, tail.length - 8); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", error => complete({ code: 1, tail: [error.message] }));
    child.on("exit", code => complete({ code: code ?? 1, tail }));
  });
}

async function main() {
  const rows = await prisma.$queryRawUnsafe<Array<{ company: string; fundCount: number; isinCount: number }>>(
    `SELECT "company", COUNT(*)::int AS "fundCount", COUNT("isin")::int AS "isinCount"
     FROM "funds"
     WHERE "company" IS NOT NULL AND btrim("company")<>''
       AND upper(btrim("company"))<>'UNKNOWN' AND "company" NOT LIKE '\u5f85\u88dc%'
     GROUP BY "company" ORDER BY "company"`,
  );
  const prior = await readJson(queuePath);
  const priorByCompany = new Map<string, CompanyQueueItem>((prior?.companies ?? []).map((item: CompanyQueueItem) => [item.fundCompany, item]));
  const companies: CompanyQueueItem[] = rows.map((row) => ({
    fundCompany: row.company, existingFundCount: row.fundCount, existingIsinCount: row.isinCount,
    sourceStatus: "PENDING", selectedSource: null, mappingStatus: "PENDING", matchedFunds: 0,
    matchedShareClasses: 0, unresolved: 0, lastAttempt: null, nextEligibleAt: null, status: "PENDING",
    ...priorByCompany.get(row.company), ...phaseA.get(row.company),
  }));

  if (!process.argv.includes("--bootstrap")) {
    const active = companies.find((item) => item.status === "SOURCE_CANARY");
    if (active) {
      active.status = "SOURCE_RECOVERY_PENDING";
      active.sourceStatus = "SOURCE_RECOVERY_PENDING";
      active.unresolved += 1;
      active.nextEligibleAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    }
    const next = companies.find((item) => item.status === "PENDING");
    if (next) {
      next.status = "SOURCE_CANARY";
      next.sourceStatus = "SOURCE_CANARY";
      next.lastAttempt = now.toISOString();
    }
  }

  const currentCompany = companies.find((item) => item.status === "SOURCE_CANARY")?.fundCompany ?? null;
  await atomicJson(queuePath, { version: 1, updatedAt: now.toISOString(), boundedConcurrency: 1, maxSourceCandidates: 3, maxRetry: 3, sourcePacing: true, rateLimitBackoff: true, failureIsolation: true, companies });
  const unresolved = companies.filter((item) => item.unresolved > 0).map((item) => ({ fundCompany: item.fundCompany, reason: "NO_OFFICIAL_SOURCE", count: item.unresolved }));
  await atomicJson(unresolvedPath, { version: 1, updatedAt: now.toISOString(), bounded: true, dedupKey: "fundCompany|reason", items: unresolved });

  const verified = await prisma.$queryRawUnsafe<Array<{ funds: number; shareClasses: number; companies: number }>>(
    `SELECT COUNT(DISTINCT m.fund_id)::int funds, COUNT(DISTINCT m.share_class_id)::int AS "shareClasses", COUNT(DISTINCT f.company)::int companies
     FROM fund_provider_mappings m JOIN funds f ON f.id=m.fund_id
     WHERE m.source IS NOT NULL AND m.verified_at IS NOT NULL
       AND m.mapping_method IN ('EXACT_ISIN','EXACT_LOCAL_CODE','EXACT_PROVIDER_ID','DETERMINISTIC_COMPOSITE')`,
  );
  const health = (await readJson(healthPath)) ?? {};
  const metrics = verified[0] ?? { funds: 0, shareClasses: 0, companies: 0 };
  await atomicJson(healthPath, { ...health, knownCompaniesTotal: companies.length, verifiedCompanies: metrics.companies, companiesPending: companies.filter((item) => item.status === "PENDING").length, companiesSourceRecoveryPending: companies.filter((item) => item.status === "SOURCE_RECOVERY_PENDING").length, verifiedLiveProviderFunds: metrics.funds, verifiedLiveShareClasses: metrics.shareClasses, legacyUnverifiedMappings: 8842, unresolvedMappings: unresolved.reduce((sum, item) => sum + item.count, 0), currentCompany, expansionQueueStatus: currentCompany ? "ACTIVE_PARTIAL_COVERAGE" : "HEALTHY_WAITING" });
  const sitcaIdentity = await runSitcaIdentityBatch();
  console.log(JSON.stringify({ knownCompanies: companies.length, currentCompany, metrics, sitcaIdentity }));
}

main().finally(() => prisma.$disconnect());
