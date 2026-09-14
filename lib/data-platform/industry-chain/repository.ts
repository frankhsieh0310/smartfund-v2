import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.ts";
import type { TpexIndustryDocument } from "./tpex.ts";
import { TPEX_INDUSTRY_CHAIN_SOURCE } from "./tpex.ts";

const BATCH_SIZE = 100;
const stableId = (kind: string, ...parts: string[]) => createHash("sha256").update([kind, ...parts].join("|")).digest("hex").slice(0, 32);

type StockResolution = { ticker: string; stockId: string; matches: number };

export async function importTpexDocument(document: TpexIndustryDocument, retrievedAt = new Date()) {
  const industryId = stableId("industry", document.industry.sourceId);
  const nodeIds = new Map(document.nodes.map((node) => [node.sourceId, stableId("node", document.industry.sourceId, node.sourceId)]));
  const tickers = [...new Set(document.memberships.flatMap((member) => member.officialTicker ? [member.officialTicker] : []))];
  const resolved = tickers.length
    ? await prisma.$queryRaw<StockResolution[]>(Prisma.sql`
        SELECT ticker, min(id::text)::uuid AS "stockId", count(*)::int AS matches
        FROM stocks WHERE country='TW' AND ticker IN (${Prisma.join(tickers)}) GROUP BY ticker`)
    : [];
  const stockMap = new Map(resolved.map((row) => [row.ticker, row]));
  const membershipCandidates = document.memberships.map((member) => {
    const membershipId = stableId("membership", document.industry.sourceId, member.nodeSourceId, member.officialTicker ?? member.officialReference);
    const match = member.officialTicker ? stockMap.get(member.officialTicker) : undefined;
    return {
      membershipId,
      evidenceId: stableId("evidence", membershipId),
      nodeId: nodeIds.get(member.nodeSourceId),
      companyName: member.companyName,
      officialTicker: member.officialTicker,
      officialReference: member.officialReference,
      marketCategory: member.marketCategory,
      stockId: match?.stockId ?? null,
      mappingStatus: !member.officialTicker || !match ? "UNMAPPED" : match.matches === 1 ? "MAPPED" : "AMBIGUOUS",
      sourceIdentifier: `${document.industry.sourceId}:${member.nodeSourceId}`,
    };
  });
  const memberships = [...new Map(membershipCandidates.map((member) => [member.membershipId, member])).values()];

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`INSERT INTO industry_chain_industries (id, canonical_name, source, source_identifier, source_reference, retrieved_at, created_at, updated_at)
      VALUES (${industryId}, ${document.industry.name}, ${TPEX_INDUSTRY_CHAIN_SOURCE}, ${document.industry.sourceId}, ${document.industry.sourceReference}, ${retrievedAt}, NOW(), NOW())
      ON CONFLICT (source, source_identifier) DO UPDATE SET canonical_name=EXCLUDED.canonical_name, source_reference=EXCLUDED.source_reference, retrieved_at=EXCLUDED.retrieved_at, updated_at=NOW()`);
    for (const node of document.nodes) {
      await tx.$executeRaw(Prisma.sql`INSERT INTO industry_chain_nodes (id, industry_id, canonical_name, hierarchy_level, chain_stage, source_identifier, created_at, updated_at)
        VALUES (${nodeIds.get(node.sourceId)}, ${industryId}, ${node.name}, 'SUB_INDUSTRY', ${node.stage}, ${node.sourceId}, NOW(), NOW())
        ON CONFLICT (industry_id, source_identifier) DO UPDATE SET canonical_name=EXCLUDED.canonical_name, chain_stage=EXCLUDED.chain_stage, updated_at=NOW()`);
    }
  }, { timeout: 30_000 });

  for (let offset = 0; offset < memberships.length; offset += BATCH_SIZE) {
    const payload = JSON.stringify(memberships.slice(offset, offset + BATCH_SIZE));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        WITH input AS (SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS x(
          "membershipId" text, "evidenceId" text, "nodeId" text, "companyName" text,
          "officialTicker" text, "officialReference" text, "marketCategory" text,
          "stockId" uuid, "mappingStatus" text, "sourceIdentifier" text))
        INSERT INTO industry_chain_memberships
          (id, industry_node_id, stock_id, company_name, official_ticker, official_reference,
           market_category, mapping_status, source_key, active, created_at, updated_at)
        SELECT x."membershipId", x."nodeId", x."stockId", x."companyName", x."officialTicker",
          x."officialReference", x."marketCategory", x."mappingStatus", x."membershipId", TRUE, NOW(), NOW()
        FROM input x ON CONFLICT (source_key) DO UPDATE SET
          company_name=EXCLUDED.company_name, official_ticker=EXCLUDED.official_ticker,
          official_reference=EXCLUDED.official_reference, market_category=EXCLUDED.market_category,
          stock_id=EXCLUDED.stock_id, mapping_status=EXCLUDED.mapping_status, active=TRUE, updated_at=NOW()`);
      await tx.$executeRaw(Prisma.sql`
        WITH input AS (SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS x(
          "membershipId" text, "evidenceId" text, "nodeId" text, "companyName" text,
          "officialTicker" text, "officialReference" text, "marketCategory" text,
          "stockId" uuid, "mappingStatus" text, "sourceIdentifier" text))
        INSERT INTO industry_chain_evidence
          (id, membership_id, source, source_reference, source_identifier, retrieved_at,
           verified_at, verification_status, created_at, updated_at)
        SELECT x."evidenceId", x."membershipId", ${TPEX_INDUSTRY_CHAIN_SOURCE},
          ${document.industry.sourceReference}, x."sourceIdentifier", ${retrievedAt}, ${retrievedAt},
          'OFFICIAL', NOW(), NOW() FROM input x
        ON CONFLICT (membership_id, source, source_identifier) DO UPDATE SET
          source_reference=EXCLUDED.source_reference, retrieved_at=EXCLUDED.retrieved_at,
          verified_at=EXCLUDED.verified_at, verification_status='OFFICIAL', updated_at=NOW()`);
    }, { timeout: 30_000 });
  }

  const observedPayload = JSON.stringify(memberships.map((member) => ({ membershipId: member.membershipId })));
  await prisma.$executeRaw(Prisma.sql`
    WITH observed AS (SELECT * FROM jsonb_to_recordset(${observedPayload}::jsonb) AS x("membershipId" text))
    UPDATE industry_chain_memberships m SET active=FALSE, updated_at=NOW()
    WHERE m.industry_node_id IN (SELECT id FROM industry_chain_nodes WHERE industry_id=${industryId})
      AND NOT EXISTS (SELECT 1 FROM observed o WHERE o."membershipId"=m.source_key)`);

  return { industryId, nodes: document.nodes.length, memberships: document.memberships.length, batchSize: BATCH_SIZE };
}
