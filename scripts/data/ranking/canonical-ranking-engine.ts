import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.ts'

export type DefinitionStatus = 'READY_NOW' | 'READY_AFTER_BACKGROUND' | 'BLOCKED_UPSTREAM' | 'SOURCE_CONSTRAINED' | 'LICENSE_CONSTRAINED' | 'INVALID_DEFINITION'
type Definition = {
  code: string; name: string; assetType: string; metricCode: string; valueSemantic: string; unit: string;
  period: string | null; direction: 'ASC' | 'DESC'; currencyPolicy: string; sourceRelation: string;
  status: DefinitionStatus; canary?: boolean
}
type Candidate = {
  canonicalEntityId: string; metricValue: unknown; metricAsOfDate: Date; currency: string | null;
  source: string | null; sourceRecordId: string | null
}
type DefinitionRow = { id: string; rankingCode: string; definitionStatus: string; metricVersion: string; eligibilityRuleVersion: string }

export const EXCLUSION_REASONS = ['MISSING_METRIC','INSUFFICIENT_HISTORY','STALE_DATA','INVALID_VALUE','CURRENCY_INCOMPATIBLE','SEMANTIC_INCOMPATIBLE','SOURCE_CONSTRAINED','LICENSE_CONSTRAINED','INACTIVE_ENTITY','UNMAPPED_IDENTITY','OTHER_VERIFIED'] as const
export const TIE_METHOD = 'DENSE_RANK'
export const PERCENTILE_METHOD = 'PERCENT_RANK_V1'

const root = resolve(import.meta.dirname, '..', '..', '..')
const catalogPath = resolve(root, 'config', 'ranking-definition-catalog.json')

export async function loadCatalog(): Promise<{ definitions: Definition[] }> {
  return JSON.parse(await readFile(catalogPath, 'utf8'))
}

export async function seedContractsAndDefinitions(definitions: Definition[]): Promise<void> {
  for (const definition of definitions) {
    const contractId = randomUUID()
    const metricVersion = `${definition.metricCode}_V1`
    await prisma.$executeRaw`
      INSERT INTO ranking_metric_contracts
        (id, metric_code, asset_type, value_semantic, unit, period, return_type, currency_semantic,
         adjustment_semantic, source_type, higher_is_better, null_policy, eligibility_rule,
         metric_version, created_at, updated_at)
      VALUES
        (${contractId}, ${definition.metricCode}, ${definition.assetType}, ${definition.valueSemantic}, ${definition.unit},
         ${definition.period}, ${definition.valueSemantic.includes('RETURN') ? definition.valueSemantic : null},
         ${definition.currencyPolicy}, ${definition.valueSemantic.includes('RETURN') ? 'SOURCE_DECLARED' : 'NOT_APPLICABLE'},
         'CANONICAL_RELATION', ${definition.direction === 'DESC'}, 'EXCLUDE',
         ${JSON.stringify({ identityValid: true, active: true, finiteMetric: true, semanticCompatible: true })}::jsonb,
         ${metricVersion}, NOW(), NOW())
      ON CONFLICT (asset_type, metric_code, metric_version) DO UPDATE SET
        value_semantic=EXCLUDED.value_semantic, unit=EXCLUDED.unit, period=EXCLUDED.period,
        return_type=EXCLUDED.return_type, currency_semantic=EXCLUDED.currency_semantic,
        higher_is_better=EXCLUDED.higher_is_better, eligibility_rule=EXCLUDED.eligibility_rule, updated_at=NOW()`
    const [{ id }] = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ranking_metric_contracts WHERE asset_type=${definition.assetType} AND metric_code=${definition.metricCode} AND metric_version=${metricVersion}`
    await prisma.$executeRaw`
      INSERT INTO ranking_definitions
        (id, ranking_code, name, asset_type, metric_code, metric_contract_id, direction, period,
         universe_type, currency_policy, minimum_coverage, minimum_history_days, minimum_ranked_entities,
         eligibility_rule_version, metric_version, definition_status, status, created_at, updated_at)
      VALUES (${randomUUID()}, ${definition.code}, ${definition.name}, ${definition.assetType}, ${definition.metricCode}, ${id},
        ${definition.direction}, ${definition.period}, 'GLOBAL', ${definition.currencyPolicy}, 0.01,
        ${definition.period === '1Y' ? 365 : null}, ${definition.canary ? 3 : 10}, 'ELIGIBILITY_V1', ${metricVersion},
        ${definition.status}, 'ACTIVE', NOW(), NOW())
      ON CONFLICT (ranking_code) DO UPDATE SET name=EXCLUDED.name, metric_contract_id=EXCLUDED.metric_contract_id,
        direction=EXCLUDED.direction, period=EXCLUDED.period, currency_policy=EXCLUDED.currency_policy,
        metric_version=EXCLUDED.metric_version, definition_status=EXCLUDED.definition_status, updated_at=NOW()`
  }
}

async function readCanonical(definition: Definition): Promise<{ total: number; rows: Candidate[] }> {
  if (definition.code === 'STOCK_MOST_ACTIVE') {
    const [count] = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint count FROM stocks WHERE is_active=true`
    const rows = await prisma.$queryRaw<Candidate[]>`SELECT DISTINCT ON (s.id) s.id AS "canonicalEntityId", h.volume AS "metricValue", h.date AS "metricAsOfDate", s.currency, h.source, h.id AS "sourceRecordId" FROM stocks s JOIN stock_history h ON h.stock_id=s.id WHERE s.is_active=true AND h.volume IS NOT NULL ORDER BY s.id, h.date DESC`
    return { total: Number(count.count), rows }
  }
  if (definition.code === 'ETF_PRICE_RETURN_1Y') {
    const [count] = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint count FROM etfs WHERE is_active=true`
    const rows = await prisma.$queryRaw<Candidate[]>`SELECT DISTINCT ON (e.id) e.id AS "canonicalEntityId", h.return_1y AS "metricValue", h.date AS "metricAsOfDate", e.currency, COALESCE(e.data_source,e.data_provider,e.provider) AS source, h.id AS "sourceRecordId" FROM etfs e JOIN etf_history h ON h.etf_id=e.id WHERE e.is_active=true AND h.return_1y IS NOT NULL ORDER BY e.id, h.date DESC`
    return { total: Number(count.count), rows }
  }
  if (definition.code === 'CRYPTO_MARKET_CAP') {
    const [count] = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint count FROM crypto_assets WHERE active=true AND stablecoin=false`
    const rows = await prisma.$queryRaw<Candidate[]>`SELECT DISTINCT ON (a.id) a.id AS "canonicalEntityId", m.market_cap AS "metricValue", m.observed_at AS "metricAsOfDate", 'USD'::text AS currency, m.source, m.source_record_id AS "sourceRecordId" FROM crypto_assets a JOIN crypto_market_cap_supply m ON m.asset_id=a.id WHERE a.active=true AND a.stablecoin=false AND m.market_cap IS NOT NULL ORDER BY a.id, m.observed_at DESC`
    return { total: Number(count.count), rows }
  }
  if (definition.code === 'FX_PAIR_PERFORMANCE_1D') {
    const [count] = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint count FROM fx_pairs WHERE active=true`
    const rows = await prisma.$queryRaw<Candidate[]>`WITH x AS (SELECT p.symbol, p.quote_currency, c.close_time, c.close, c.source, c.source_record_id, ROW_NUMBER() OVER(PARTITION BY p.symbol ORDER BY c.close_time DESC) rn FROM fx_pairs p JOIN fx_candles c ON c.pair_symbol=p.symbol WHERE p.active=true AND LOWER(c.interval) IN ('1d','daily','day')) SELECT n.symbol AS "canonicalEntityId", ((n.close/o.close)-1)*100 AS "metricValue", n.close_time AS "metricAsOfDate", n.quote_currency AS currency, n.source, n.source_record_id AS "sourceRecordId" FROM x n JOIN x o ON o.symbol=n.symbol AND o.rn=2 WHERE n.rn=1 AND o.close<>0`
    return { total: Number(count.count), rows }
  }
  if (definition.code === 'INDEX_RETURN_1D') {
    const [count] = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint count FROM global_index_registry WHERE active=true`
    const rows = await prisma.$queryRaw<Candidate[]>`WITH x AS (SELECT r.id, r.currency, o.observation_date, o.value, o.source, o.source_record_id, ROW_NUMBER() OVER(PARTITION BY r.id ORDER BY o.observation_date DESC) rn FROM global_index_registry r JOIN global_index_daily_observations o ON o.index_id=r.id WHERE r.active=true AND r.return_type='PRICE') SELECT n.id AS "canonicalEntityId", ((n.value/o.value)-1)*100 AS "metricValue", n.observation_date AS "metricAsOfDate", n.currency, n.source, n.source_record_id AS "sourceRecordId" FROM x n JOIN x o ON o.id=n.id AND o.rn=2 WHERE n.rn=1 AND o.value<>0`
    return { total: Number(count.count), rows }
  }
  return { total: 0, rows: [] }
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function runCanary(definition: Definition): Promise<{ code: string; status: string; total: number; eligible: number; ranked: number; excluded: number; snapshotCreated: boolean }> {
  const dbDefinition = (await prisma.$queryRaw<DefinitionRow[]>`SELECT id, ranking_code AS "rankingCode", definition_status AS "definitionStatus", metric_version AS "metricVersion", eligibility_rule_version AS "eligibilityRuleVersion" FROM ranking_definitions WHERE ranking_code=${definition.code}`)[0]
  const input = await readCanonical(definition)
  const valid = input.rows.map(row => ({ ...row, numeric: finite(row.metricValue) })).filter((row): row is Candidate & { numeric: number } => row.numeric !== null && !!row.canonicalEntityId && !!row.metricAsOfDate)
  const excluded = Math.max(0, input.total - valid.length)
  if (!valid.length) return { code: definition.code, status: 'BLOCKED_UPSTREAM', total: input.total, eligible: 0, ranked: 0, excluded, snapshotCreated: false }
  const asOfDate = valid.reduce((latest, row) => row.metricAsOfDate > latest ? row.metricAsOfDate : latest, valid[0].metricAsOfDate)
  const watermark = `${definition.sourceRelation}:${asOfDate.toISOString()}`
  const universeVersion = `CANONICAL:${watermark}`
  const existing = await prisma.$queryRaw<Array<{ id: string }>>`SELECT s.id FROM ranking_snapshots s WHERE s.ranking_id=${dbDefinition.id} AND s.as_of_date=${asOfDate}::date AND s.metric_version=${dbDefinition.metricVersion} AND s.eligibility_rule_version=${dbDefinition.eligibilityRuleVersion} AND s.universe_version=${universeVersion}`
  if (existing.length) return { code: definition.code, status: 'NO_OP_CURRENT', total: input.total, eligible: valid.length, ranked: valid.length, excluded, snapshotCreated: false }

  valid.sort((a,b) => definition.direction === 'DESC' ? b.numeric-a.numeric || a.canonicalEntityId.localeCompare(b.canonicalEntityId) : a.numeric-b.numeric || a.canonicalEntityId.localeCompare(b.canonicalEntityId))
  let denseRank = 0; let previous: number | undefined
  const dense = valid.map(row => { if (previous === undefined || row.numeric !== previous) { denseRank++; previous=row.numeric } return { ...row, rank:denseRank } })
  const groups = denseRank
  const coverage = input.total ? valid.length / input.total : 0
  const freshnessDays = (Date.now() - asOfDate.getTime()) / 86_400_000
  const freshness = freshnessDays <= (definition.assetType === 'CRYPTO' ? 2 : 10) ? 'CURRENT' : 'STALE'
  const quality = valid.length < 3 ? 'INSUFFICIENT_UNIVERSE' : coverage < 0.8 ? 'PARTIAL_COVERAGE' : freshness === 'STALE' ? 'STALE' : 'FULL'
  const universeId = randomUUID(); const snapshotId = randomUUID()
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO ranking_universe_snapshots (id,ranking_id,as_of_date,universe_version,total_canonical_entities,eligible_count,excluded_count,ranked_count,coverage_percent,exclusion_summary,freshness_status,source_watermark,created_at) VALUES (${universeId},${dbDefinition.id},${asOfDate}::date,${universeVersion},${input.total},${valid.length},${excluded},${valid.length},${coverage*100},${JSON.stringify({ MISSING_METRIC: excluded })}::jsonb,${freshness},${watermark},NOW())`
    await tx.$executeRaw`INSERT INTO ranking_snapshots (id,ranking_id,as_of_date,generated_at,universe_snapshot_id,universe_version,metric_version,eligibility_rule_version,percentile_method_version,tie_method,status,quality_status,freshness_status,provenance_coverage,created_at) VALUES (${snapshotId},${dbDefinition.id},${asOfDate}::date,NOW(),${universeId},${universeVersion},${dbDefinition.metricVersion},${dbDefinition.eligibilityRuleVersion},${PERCENTILE_METHOD},${TIE_METHOD},'CURRENT',${quality},${freshness},${valid.filter(x=>x.source).length/valid.length*100},NOW())`
    for (const row of dense) {
      const percentile = groups === 1 ? 100 : ((groups-row.rank)/(groups-1))*100
      await tx.$executeRaw`INSERT INTO ranking_results (id,ranking_snapshot_id,asset_type,canonical_entity_id,rank,percentile,metric_value,metric_unit,metric_as_of_date,currency,period,source_freshness,source_relation,source_record_id,tie_group,created_at) VALUES (${randomUUID()},${snapshotId},${definition.assetType},${row.canonicalEntityId},${row.rank},${percentile},${row.numeric},${definition.unit},${row.metricAsOfDate}::date,${row.currency},${definition.period},${freshness},${definition.sourceRelation},${row.sourceRecordId},${row.rank},NOW())`
    }
  }, { timeout: 60_000 })
  return { code: definition.code, status: quality, total: input.total, eligible: valid.length, ranked: valid.length, excluded, snapshotCreated: true }
}

export async function queueBackground(definitions: Definition[]): Promise<number> {
  let queued=0
  for (const definition of definitions.filter(d=>d.status==='READY_AFTER_BACKGROUND')) {
    const [row] = await prisma.$queryRaw<Array<{ id:string }>>`SELECT id FROM ranking_definitions WHERE ranking_code=${definition.code}`
    const watermark='WAITING_FOR_UPSTREAM'
    const changed=await prisma.$executeRaw`INSERT INTO ranking_work_items (id,ranking_id,reason,upstream_asset,upstream_watermark,dedupe_key,status,attempts,created_at) VALUES (${randomUUID()},${row.id},'UPSTREAM_WATERMARK_PENDING',${definition.assetType},${watermark},${`${definition.code}:${watermark}`},'PENDING',0,NOW()) ON CONFLICT (dedupe_key) DO NOTHING`
    queued+=changed
  }
  return queued
}

export async function disconnectRankingDb(): Promise<void> { await prisma.$disconnect() }
