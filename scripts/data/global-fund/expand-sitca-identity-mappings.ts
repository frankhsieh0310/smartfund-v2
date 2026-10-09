import { PrismaClient } from "@prisma/client";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchSitcaFscNav, SITCA_FSC_NAV_SOURCE, type SitcaFundNavRecord } from "./adapters/sitca-fsc-nav";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const batchArg = process.argv.find((arg) => arg.startsWith("--batch="));
const batchSize = Math.max(1, Math.min(100, Number(batchArg?.split("=")[1] ?? "50")));
const queuePath = resolve("runtime/global-fund/unresolved-mappings.json");
const checkpointPath = resolve("runtime/global-fund/provider-expansion/sitca-identity-checkpoint.json");

const normalize = (value: string | null | undefined) => (value ?? "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
const identityKey = (name: string, company: string, currency: string) => `${normalize(name)}|${normalize(company)}|${currency.trim().toUpperCase()}`;

async function atomicJson(path: string, value: unknown) {
  await mkdir(resolve("runtime/global-fund"), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
  const source = await fetchSitcaFscNav();
  const funds = await prisma.fund.findMany({ select: { id: true, isin: true, code: true, name: true, company: true, currency: true } });
  const providerMappings = await prisma.fundProviderMapping.findMany({
    where: {
      provider: "SITCA", source: { not: null }, verifiedAt: { not: null },
      mappingMethod: { in: ["EXACT_ISIN", "EXACT_LOCAL_CODE", "EXACT_PROVIDER_ID", "DETERMINISTIC_COMPOSITE"] },
    },
    select: { fundId: true, providerCode: true },
  });
  const fundMappings = await prisma.fundMapping.findMany({ select: { fundId: true, moneydjCode: true } });
  const fundById = new Map(funds.map((fund) => [fund.id, fund]));
  const providers = new Map(providerMappings.map((mapping) => [mapping.providerCode, mapping.fundId]));
  const localCodes = new Map<string, string[]>();
  for (const mapping of fundMappings) if (mapping.moneydjCode) localCodes.set(mapping.moneydjCode, [...(localCodes.get(mapping.moneydjCode) ?? []), mapping.fundId]);
  const codes = new Map<string, string[]>();
  for (const fund of funds) {
    if (fund.code) codes.set(fund.code, [...(codes.get(fund.code) ?? []), fund.id]);
  }
  const sourceCodeCounts = new Map<string, number>();
  for (const record of source) sourceCodeCounts.set(record.code, (sourceCodeCounts.get(record.code) ?? 0) + 1);

  const tiers = { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 0 };
  const mapped: Array<{ record: SitcaFundNavRecord; fundId: string; method: string }> = [];
  const unresolved: Array<Record<string, unknown>> = [];
  for (const record of source) {
    let method = "";
    let candidates: string[] = [];
    const providerFund = providers.get(record.sourceRecordId);
    if (providerFund) { method = "EXACT_EXISTING_PROVIDER_MAPPING"; candidates = [providerFund]; tiers.tier2++; }
    else {
      const local = localCodes.get(record.code) ?? [];
      const compatibleLocal = local.filter((id) => {
        const fund = fundById.get(id)!;
        return identityKey(fund.name, fund.company, fund.currency) === identityKey(record.name, record.company, record.currency);
      });
      if (compatibleLocal.length === 1) { method = "EXACT_LOCAL_CODE"; candidates = compatibleLocal; tiers.tier3++; }
      else {
        const exactCode = (codes.get(record.code) ?? []).filter((id) => {
          const fund = fundById.get(id)!;
          return identityKey(fund.name, fund.company, fund.currency) === identityKey(record.name, record.company, record.currency);
        });
        if (exactCode.length === 1) { method = "EXACT_SOURCE_CODE"; candidates = exactCode; tiers.tier4++; }
        else candidates = [...new Set([...compatibleLocal, ...exactCode])];
      }
    }
    if (candidates.length === 1 && method) mapped.push({ record, fundId: candidates[0], method });
    else unresolved.push({
      sourceRecordId: record.sourceRecordId, sourceCode: record.code, fundName: record.name,
      fundCompany: record.company, currency: record.currency,
      classification: "IDENTITY_PENDING",
      reason: candidates.length > 1 ? "AMBIGUOUS_PARENT" : "NO_DETERMINISTIC_IDENTIFIER_MATCH",
      candidateFundIds: candidates, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
    });
  }

  if (apply) {
    await prisma.$transaction(async (db) => {
      const lock = await db.$queryRawUnsafe<Array<{ locked: boolean }>>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:global-fund:mapping:v1')) AS locked`);
      if (!lock[0]?.locked) throw new Error("GLOBAL_FUND_MAPPING_SINGLE_WRITER_LOCKED");
      for (const item of mapped.slice(0, batchSize)) {
        await db.$executeRawUnsafe(
          `UPDATE "fund_share_classes" SET "source_record_id"=$1, "updated_at"=CURRENT_TIMESTAMP
           WHERE "fund_id"=$2 AND "source"=$3 AND "source_record_id"=$4`,
          item.record.sourceRecordId, item.fundId, SITCA_FSC_NAV_SOURCE, item.record.code,
        );
        await db.fundProviderMapping.upsert({
          where: { fundId_provider: { fundId: item.fundId, provider: "SITCA" } },
          create: { fundId: item.fundId, provider: "SITCA", providerCode: item.record.sourceRecordId, status: `MATCHED_${item.method}` },
          update: { providerCode: item.record.sourceRecordId, status: `MATCHED_${item.method}`, lastCheckedAt: new Date() },
        });
        await db.$executeRawUnsafe(
          `INSERT INTO "fund_share_classes" ("id","fund_id","share_class_name","share_class_code","currency","status","domicile","source","source_record_id","created_at","updated_at")
           VALUES ($1,$2,$3,$4,$5,'ACTIVE','TW',$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
           ON CONFLICT ("fund_id","source","source_record_id") DO UPDATE SET "share_class_name"=EXCLUDED."share_class_name","share_class_code"=EXCLUDED."share_class_code","currency"=EXCLUDED."currency","updated_at"=CURRENT_TIMESTAMP`,
          crypto.randomUUID(), item.fundId, item.record.name, item.record.code, item.record.currency, SITCA_FSC_NAV_SOURCE, item.record.sourceRecordId,
        );
      }
    }, { maxWait: 10_000, timeout: 120_000 });
  }
  await atomicJson(queuePath, { source: SITCA_FSC_NAV_SOURCE, generatedAt: new Date().toISOString(), bounded: true, records: unresolved });
  await atomicJson(checkpointPath, {
    version: 1, source: SITCA_FSC_NAV_SOURCE, updatedAt: new Date().toISOString(),
    sourceRecords: source.length, deterministicMapped: mapped.length, processedThisRun: apply ? Math.min(mapped.length, batchSize) : 0,
    identityPending: unresolved.length, sourceInvalid: 0, batchSize, status: unresolved.length ? "IDENTITY_PENDING" : "COMPLETE_AS_AVAILABLE",
    nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), autoContinuing: true,
  });
  const ambiguous = unresolved.filter((item) => item.reason === "AMBIGUOUS_PARENT").length;
  console.log(JSON.stringify({ sourceRecordsTotal: source.length, existingFunds: funds.length, ...tiers, totalMapped: mapped.length, unresolved: unresolved.length, ambiguous, coveragePercent: Number((mapped.length / source.length * 100).toFixed(4)), applied: apply, batchSize, nameOnlyFuzzyPromotions: 0 }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
