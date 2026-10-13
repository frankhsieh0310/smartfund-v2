import { prisma } from '../../prisma.ts'

export interface RankingServiceResult {
  rank: number
  entity: { assetType: string; canonicalEntityId: string }
  metricValue: number
  metricUnit: string
  percentile: number
  currency: string | null
  period: string | null
  metricAsOfDate: string
  provenance: { sourceRelation: string; sourceRecordId: string | null }
}

type RankingRow = {
  rankingCode: string; name: string; assetType: string; metricCode: string; direction: string;
  asOfDate: Date; qualityStatus: string; freshnessStatus: string; total: number; eligible: number;
  ranked: number; excluded: number; coverage: unknown; rank: number; canonicalEntityId: string;
  metricValue: unknown; metricUnit: string; percentile: unknown; currency: string | null; period: string | null;
  metricAsOfDate: Date; sourceRelation: string; sourceRecordId: string | null
}

const mapResult = (row: RankingRow): RankingServiceResult => ({
  rank: row.rank,
  entity: { assetType: row.assetType, canonicalEntityId: row.canonicalEntityId },
  metricValue: Number(row.metricValue), metricUnit: row.metricUnit, percentile: Number(row.percentile),
  currency: row.currency, period: row.period, metricAsOfDate: row.metricAsOfDate.toISOString(),
  provenance: { sourceRelation: row.sourceRelation, sourceRecordId: row.sourceRecordId },
})

export async function getCanonicalRanking(rankingCode: string, limit = 100) {
  const rows = await prisma.$queryRaw<RankingRow[]>`
    SELECT d.ranking_code AS "rankingCode", d.name, d.asset_type AS "assetType", d.metric_code AS "metricCode", d.direction,
      s.as_of_date AS "asOfDate", s.quality_status AS "qualityStatus", s.freshness_status AS "freshnessStatus",
      u.total_canonical_entities AS total, u.eligible_count AS eligible, u.ranked_count AS ranked,
      u.excluded_count AS excluded, u.coverage_percent AS coverage, r.rank,
      r.canonical_entity_id AS "canonicalEntityId", r.metric_value AS "metricValue", r.metric_unit AS "metricUnit",
      r.percentile, r.currency, r.period, r.metric_as_of_date AS "metricAsOfDate",
      r.source_relation AS "sourceRelation", r.source_record_id AS "sourceRecordId"
    FROM ranking_definitions d
    JOIN ranking_snapshots s ON s.ranking_id=d.id
    JOIN ranking_universe_snapshots u ON u.id=s.universe_snapshot_id
    JOIN ranking_results r ON r.ranking_snapshot_id=s.id
    WHERE d.ranking_code=${rankingCode} AND s.id=(SELECT s2.id FROM ranking_snapshots s2 WHERE s2.ranking_id=d.id AND s2.quality_status NOT IN ('INVALID','UNKNOWN') ORDER BY s2.as_of_date DESC, s2.generated_at DESC LIMIT 1)
    ORDER BY r.rank, r.canonical_entity_id LIMIT ${Math.min(Math.max(limit,1),200)}`
  const head=rows[0]
  return head ? { metadata:{rankingCode:head.rankingCode,name:head.name,assetType:head.assetType,metricCode:head.metricCode,direction:head.direction},asOfDate:head.asOfDate.toISOString(),universe:{total:head.total,eligible:head.eligible,ranked:head.ranked,excluded:head.excluded},coverage:Number(head.coverage),freshness:head.freshnessStatus,quality:head.qualityStatus,results:rows.map(mapResult) } : null
}

export async function getEntityRankings(assetType: string, canonicalEntityId: string) {
  const rows = await prisma.$queryRaw<RankingRow[]>`
    SELECT d.ranking_code AS "rankingCode", d.name, d.asset_type AS "assetType", d.metric_code AS "metricCode", d.direction,
      s.as_of_date AS "asOfDate", s.quality_status AS "qualityStatus", s.freshness_status AS "freshnessStatus",
      u.total_canonical_entities AS total, u.eligible_count AS eligible, u.ranked_count AS ranked,
      u.excluded_count AS excluded, u.coverage_percent AS coverage, r.rank,
      r.canonical_entity_id AS "canonicalEntityId", r.metric_value AS "metricValue", r.metric_unit AS "metricUnit",
      r.percentile, r.currency, r.period, r.metric_as_of_date AS "metricAsOfDate",
      r.source_relation AS "sourceRelation", r.source_record_id AS "sourceRecordId"
    FROM ranking_results r JOIN ranking_snapshots s ON s.id=r.ranking_snapshot_id
    JOIN ranking_definitions d ON d.id=s.ranking_id JOIN ranking_universe_snapshots u ON u.id=s.universe_snapshot_id
    WHERE r.asset_type=${assetType} AND r.canonical_entity_id=${canonicalEntityId}
      AND s.id=(SELECT s2.id FROM ranking_snapshots s2 WHERE s2.ranking_id=d.id AND s2.quality_status NOT IN ('INVALID','UNKNOWN') ORDER BY s2.as_of_date DESC, s2.generated_at DESC LIMIT 1)
    ORDER BY d.ranking_code`
  return rows.map(row=>({rankingCode:row.rankingCode,name:row.name,asOfDate:row.asOfDate.toISOString(),universeSize:row.ranked,...mapResult(row)}))
}
