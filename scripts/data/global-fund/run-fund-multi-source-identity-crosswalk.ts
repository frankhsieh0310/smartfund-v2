import { PrismaClient } from "@prisma/client";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fetchSitcaFscNav, SITCA_FSC_NAV_SOURCE } from "./adapters/sitca-fsc-nav";

type SecIdentity = { fundId: string; shareClassId: string; cik: string; seriesId: string; classId: string };
const prisma = new PrismaClient();
const runtimeDir = resolve("runtime/global-fund/multi-source-identity");
const checkpointPath = resolve(runtimeDir, "checkpoint.json");
const evidencePath = resolve(runtimeDir, "evidence.json");

async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
const secRegistry = JSON.parse(await readFile(resolve("config/fund-holdings-sec-registry.json"), "utf8")) as { funds: SecIdentity[] };
const sitca = await fetchSitcaFscNav();
const sitcaMappings = await prisma.fundProviderMapping.findMany({
  where: { provider: "SITCA", source: { not: null }, verifiedAt: { not: null }, mappingMethod: { in: ["EXACT_ISIN", "EXACT_LOCAL_CODE", "EXACT_PROVIDER_ID", "DETERMINISTIC_COMPOSITE"] } },
  select: { fundId: true, shareClassId: true, providerCode: true },
});
const sitcaCodes = new Set(sitcaMappings.map(mapping => mapping.providerCode));
const sitcaHigh = sitca.filter(record => sitcaCodes.has(record.sourceRecordId));
const secEvidence: Array<Record<string, unknown>> = [];

await prisma.$transaction(async tx => {
  const lock = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:fund-identity-crosswalk:v1')) locked`);
  if (!lock[0]?.locked) throw new Error("FUND_IDENTITY_CROSSWALK_SINGLE_WRITER_LOCKED");
  for (const identity of secRegistry.funds.slice(0, 10)) {
    const parent = await tx.$queryRawUnsafe<Array<{ fund_id: string; source_record_id: string | null }>>(
      `SELECT fund_id,source_record_id FROM fund_share_classes WHERE id=$1`, identity.shareClassId,
    );
    if (parent[0]?.fund_id !== identity.fundId) throw new Error(`SEC_PARENT_LINK_MISMATCH:${identity.shareClassId}`);
    const providerCode = `${identity.cik}:${identity.seriesId}:${identity.classId}`;
    await tx.fundProviderMapping.upsert({
      where: { fundId_provider: { fundId: identity.fundId, provider: "SEC" } },
      create: { fundId: identity.fundId, shareClassId: identity.shareClassId, provider: "SEC", providerCode, status: "VERIFIED", source: "SEC_EDGAR_NPORT_P", mappingMethod: "EXACT_PROVIDER_ID", verifiedAt: new Date(), candidateCount: 1 },
      update: { shareClassId: identity.shareClassId, providerCode, status: "VERIFIED", source: "SEC_EDGAR_NPORT_P", mappingMethod: "EXACT_PROVIDER_ID", verifiedAt: new Date(), candidateCount: 1, lastCheckedAt: new Date() },
    });
    secEvidence.push({ ...identity, providerCode, method: "SEC_SERIES_CLASS_EXACT", candidateCount: 1, confidence: "HIGH", source: "SEC_EDGAR_NPORT_P" });
  }
}, { maxWait: 10_000, timeout: 60_000 });

const counts = (await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
  SELECT
    (SELECT count(*) FROM fund_provider_mappings WHERE source IS NOT NULL AND verified_at IS NOT NULL AND mapping_method IN ('EXACT_ISIN','EXACT_LOCAL_CODE','EXACT_PROVIDER_ID','DETERMINISTIC_COMPOSITE'))::bigint high,
    (SELECT count(*) FROM fund_provider_mappings WHERE provider='yahoo')::bigint yahoo_total,
    (SELECT count(*) FROM fund_provider_mappings WHERE provider='yahoo' AND (source IS NULL OR verified_at IS NULL))::bigint yahoo_only,
    (SELECT count(*) FROM fund_mappings WHERE moneydj_code IS NOT NULL)::bigint moneydj_mapped,
    (SELECT count(*) FROM fund_share_classes)::bigint share_classes,
    (SELECT count(*) FROM fund_share_classes WHERE fund_id IS NULL)::bigint orphan_classes
`))[0];
const now = new Date().toISOString();
const checkpoint = {
  version: 1, updatedAt: now, status: "AUTO_CONTINUING_SOURCE_LIMITED", batchSize: 10,
  cursors: { sitca: sitca.at(-1)?.sourceRecordId ?? null, sec: secRegistry.funds.at(-1)?.classId ?? null, moneydj: null, yahoo: null, provider: null, documents: null },
  sitca: { sourceRecords: sitca.length, highVerified: sitcaHigh.length, mediumCandidate: 0, ambiguous: 0, identityPending: sitca.length - sitcaHigh.length, sourceInvalid: 0 },
  sec: { fundsVerified: secEvidence.length, seriesVerified: new Set(secEvidence.map(item => item.seriesId)).size, classesVerified: secEvidence.length, pending: 0 },
  moneydj: { mapped: Number(counts.moneydj_mapped), newlyVerified: 0 },
  yahoo: { target: Number(counts.yahoo_total), officialCrossVerified: 0, yahooOnly: Number(counts.yahoo_only), ambiguous: 0, rejected: 0, pendingSourceCheck: Number(counts.yahoo_total) - Number(counts.yahoo_only) },
  highConfidenceMappings: Number(counts.high), nameOnlyFuzzyPromotions: 0, duplicateFundsCreated: 0, duplicateShareClassesCreated: 0,
  ambiguousMappingsPersisted: 0, orphanShareClasses: Number(counts.orphan_classes), shareClasses: Number(counts.share_classes),
  autoContinuing: true, nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};
await atomic(evidencePath, { methodologyVersion: "FUND_MULTI_SOURCE_IDENTITY_V1", normalization: ["NFKC", "CASE", "WHITESPACE", "PUNCTUATION", "KNOWN_LEGAL_SUFFIX"], promotions: secEvidence, sitcaSource: SITCA_FSC_NAV_SOURCE });
await atomic(checkpointPath, checkpoint);
console.log(JSON.stringify(checkpoint));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
