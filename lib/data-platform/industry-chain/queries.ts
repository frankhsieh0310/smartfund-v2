import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type IndustryPosition = {
  industryId: string; industry: string; stage: string; subIndustry: string;
  source: string; sourceReference: string; verifiedAt: Date | null; verificationStatus: string;
};

export async function getStockIndustryChain(symbol: string) {
  const positions = await prisma.$queryRaw<IndustryPosition[]>(Prisma.sql`
    SELECT i.id AS "industryId", i.canonical_name AS industry, n.chain_stage AS stage,
      n.canonical_name AS "subIndustry", e.source, e.source_reference AS "sourceReference",
      e.verified_at AS "verifiedAt", e.verification_status AS "verificationStatus"
    FROM industry_chain_memberships m
    JOIN industry_chain_nodes n ON n.id=m.industry_node_id
    JOIN industry_chain_industries i ON i.id=n.industry_id
    JOIN industry_chain_evidence e ON e.membership_id=m.id AND e.verification_status='OFFICIAL'
    LEFT JOIN stocks s ON s.id=m.stock_id
    WHERE m.active=TRUE AND (s.yahoo_symbol=${symbol} OR s.ticker=${symbol} OR m.official_ticker=${symbol})
    ORDER BY i.canonical_name, n.chain_stage, n.canonical_name`);
  return { symbol, positions };
}

type ChainRow = IndustryPosition & { nodeId: string; companyName: string; symbol: string | null; mappingStatus: string };
export async function getIndustryChain(industry: string) {
  const rows = await prisma.$queryRaw<ChainRow[]>(Prisma.sql`
    SELECT i.id AS "industryId", i.canonical_name AS industry, n.id AS "nodeId",
      n.chain_stage AS stage, n.canonical_name AS "subIndustry", m.company_name AS "companyName",
      COALESCE(s.yahoo_symbol, m.official_ticker) AS symbol, m.mapping_status AS "mappingStatus",
      e.source, e.source_reference AS "sourceReference", e.verified_at AS "verifiedAt",
      e.verification_status AS "verificationStatus"
    FROM industry_chain_industries i JOIN industry_chain_nodes n ON n.industry_id=i.id
    LEFT JOIN industry_chain_memberships m ON m.industry_node_id=n.id AND m.active=TRUE
    LEFT JOIN industry_chain_evidence e ON e.membership_id=m.id AND e.verification_status='OFFICIAL'
    LEFT JOIN stocks s ON s.id=m.stock_id
    WHERE i.id=${industry} OR i.source_identifier=${industry} OR LOWER(i.canonical_name)=LOWER(${industry})
    ORDER BY n.chain_stage, n.canonical_name, m.company_name`);
  if (!rows.length) return null;
  const nodes = new Map<string, { id: string; name: string; stage: string; companies: object[] }>();
  for (const row of rows) {
    const node = nodes.get(row.nodeId) ?? { id: row.nodeId, name: row.subIndustry, stage: row.stage, companies: [] };
    if (row.companyName && row.verificationStatus === "OFFICIAL") node.companies.push({ name: row.companyName, symbol: row.symbol, mappingStatus: row.mappingStatus, evidence: { source: row.source, sourceReference: row.sourceReference, verifiedAt: row.verifiedAt } });
    nodes.set(row.nodeId, node);
  }
  return { id: rows[0].industryId, name: rows[0].industry, nodes: [...nodes.values()] };
}
