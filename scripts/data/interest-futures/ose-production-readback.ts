import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
try {
  const contracts = await prisma.$queryRaw`
    SELECT id, exchange, root_symbol, contract_symbol, contract_month, expiration, currency, underlying,
           status, source, verification_status, source_url, created_at, updated_at
    FROM futures_contracts
    WHERE asset_class='INTEREST_RATE_FUTURES' AND root_symbol='TOA3M'
    ORDER BY contract_symbol
    LIMIT 5
  `;
  const observations = await prisma.$queryRaw`
    SELECT o.contract_id, c.contract_symbol, o.observed_at, o.settlement, o.open, o.high, o.low, o.close,
           o.volume, o.open_interest, o.source, o.source_key, o.source_record_id, o.source_url,
           o.verification_status, o.quality_status, o.freshness_status, o.retrieved_at,
           o.parser_version, o.source_checksum, o.license_status, o.created_at, o.updated_at
    FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id
    WHERE o.asset_class='INTEREST_RATE_FUTURES' AND c.root_symbol='TOA3M'
    ORDER BY o.observed_at
    LIMIT 10
  `;
  const semanticPass = observations.length > 0 && observations.every((row) => Number.isFinite(Number(row.settlement)) && row.open === null && row.high === null && row.low === null && row.close === null && row.source === "JPX_OSE_OFFICIAL_SETTLEMENT_CSV");
  const provenancePass = observations.length > 0 && observations.every((row) => row.source_key && row.source_record_id && row.source_url && row.verification_status && row.quality_status && row.retrieved_at && row.source_checksum);
  const duplicateGroups = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count FROM (
      SELECT o.source_key FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id
      WHERE o.asset_class='INTEREST_RATE_FUTURES' AND c.root_symbol='TOA3M'
      GROUP BY o.source_key HAVING COUNT(*) > 1
    ) duplicates
  `;
  console.log(JSON.stringify({ status: "PASS", contracts, observations, semanticPass, provenancePass, duplicateKeyGroups: duplicateGroups[0]?.count ?? null }, (_, value) => typeof value === "bigint" ? Number(value) : value));
} catch (error) {
  console.log(JSON.stringify({ status: "FAIL", errorClass: error?.code || error?.name || "UNKNOWN" }));
} finally {
  await prisma.$disconnect();
}
