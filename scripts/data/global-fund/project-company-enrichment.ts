import { PrismaClient } from "@prisma/client";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const prisma = new PrismaClient();
const runtimeDir = resolve("runtime/global-fund/company-enrichment");

async function atomicJson(name: string, value: unknown) {
  await mkdir(runtimeDir, { recursive: true });
  const path = resolve(runtimeDir, name);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
  const evaluatedAt = new Date().toISOString();
  const funds = await prisma.$queryRawUnsafe<Array<{
    fundId: string;
    fundName: string;
    isin: string | null;
    code: string | null;
    currency: string;
    currentCompany: string | null;
    hasFundMapping: boolean;
    hasProviderMapping: boolean;
    hasVerifiedProvider: boolean;
    hasHistory: boolean;
  }>>(
    `SELECT f.id AS "fundId", f.name AS "fundName", f.isin, f.code, f.currency,
       f.company AS "currentCompany",
       EXISTS (SELECT 1 FROM fund_mappings fm WHERE fm.fund_id=f.id) AS "hasFundMapping",
       EXISTS (SELECT 1 FROM fund_provider_mappings pm WHERE pm.fund_id=f.id) AS "hasProviderMapping",
       EXISTS (SELECT 1 FROM fund_provider_mappings pm WHERE pm.fund_id=f.id
         AND pm.source IS NOT NULL AND pm.verified_at IS NOT NULL
         AND pm.mapping_method IN ('EXACT_ISIN','EXACT_LOCAL_CODE','EXACT_PROVIDER_ID','DETERMINISTIC_COMPOSITE')) AS "hasVerifiedProvider",
       EXISTS (SELECT 1 FROM fund_history fh WHERE fh.fund_id=f.id) AS "hasHistory"
     FROM funds f
     WHERE f.company IS NULL OR btrim(f.company)='' OR f.company LIKE '\u5f85\u88dc%'
     ORDER BY (f.isin IS NULL), f.id`,
  );

  const queue = funds.map((fund) => ({
    fundId: fund.fundId,
    fundName: fund.fundName,
    isin: fund.isin,
    currency: fund.currency,
    currentCompany: fund.currentCompany,
    identityEvidence: fund.isin
      ? "EXACT_ISIN_LOOKUP_REQUIRED"
      : fund.hasVerifiedProvider
        ? "EXACT_VERIFIED_PROVIDER_LOOKUP_REQUIRED"
        : "LOW_IDENTITY_UNRESOLVED",
    attemptStatus: "NOT_STARTED",
    lastAttempt: null,
    nextEligibleAt: null,
    status: "PENDING",
  }));

  const summary = {
    total: funds.length,
    withIsin: funds.filter((fund) => fund.isin).length,
    withoutIsin: funds.filter((fund) => !fund.isin).length,
    withCode: funds.filter((fund) => fund.code).length,
    withFundMapping: funds.filter((fund) => fund.hasFundMapping).length,
    withProviderMapping: funds.filter((fund) => fund.hasProviderMapping).length,
    withVerifiedProvider: funds.filter((fund) => fund.hasVerifiedProvider).length,
    withHistory: funds.filter((fund) => fund.hasHistory).length,
  };

  await atomicJson("evidence.json", {
    version: 1,
    evaluatedAt,
    scope: "EXISTING_UNIVERSE_ONLY",
    databaseWritePerformed: false,
    legacyFMappingUsedAsCompanyEvidence: false,
    deterministicCanaryEligible: summary.withIsin,
    canaryGate: "FAIL_NO_MISSING_COMPANY_FUNDS_WITH_VERIFIED_IDENTITY",
    mappingMethodsAllowed: ["EXACT_ISIN", "EXACT_LOCAL_CODE", "EXACT_PROVIDER_ID", "DETERMINISTIC_OFFICIAL_NAME"],
    summary,
  });
  await atomicJson("queue.json", {
    version: 1,
    updatedAt: evaluatedAt,
    active: false,
    backgroundExpansionStarted: false,
    bounded: true,
    reason: "CANARY_GATE_NOT_MET",
    priority: ["MISSING_COMPANY_WITH_ISIN", "MISSING_COMPANY_WITH_VERIFIED_LOCAL_CODE", "MISSING_COMPANY_WITH_VERIFIED_PROVIDER_ID", "LOW_IDENTITY_UNRESOLVED"],
    items: queue,
  });
  console.log(JSON.stringify({ summary, queueItems: queue.length }));
}

main().finally(() => prisma.$disconnect());
