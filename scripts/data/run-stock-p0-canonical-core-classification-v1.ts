import { PrismaClient } from '@prisma/client';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  dispatchAt,
  isTradingDate,
  latestClosedTradingDate,
  loadExchangeCalendarRegistry,
  marketClock,
  type ExchangeCalendarJob,
} from './daily/exchange-calendar.ts';

const TASK = 'GLOBAL_STOCK_P0_CANONICAL_CORE_CLASSIFICATION_AND_PRE_MIGRATION_RECOVERY_V1';
const ROOT = path.resolve('runtime/global-stock/p0-canonical-core-classification-v1');
const AUDIT_AT = new Date();
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

type Row = {
  id: string;
  ticker: string;
  yahoo_symbol: string;
  exchange: string;
  country: string;
  currency: string;
  company_name: string;
  sector: string | null;
  industry: string | null;
  status: string;
  latest_close: unknown;
  latest_date: Date | null;
  is_active: boolean;
  coverage_id: string | null;
  history_rows: string | null;
  first_date: Date | null;
  history_latest_date: Date | null;
  last_calculated_at: Date | null;
};

const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const isoDate = (value: Date | null) => value ? value.toISOString().slice(0, 10) : null;

async function atomicJson(name: string, value: unknown) {
  await mkdir(ROOT, { recursive: true });
  const target = path.join(ROOT, name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, json(value), 'utf8');
  await rename(temp, target);
}

function inc(target: Record<string, number>, key: string) {
  target[key] = (target[key] ?? 0) + 1;
}

function nonBlank(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function subtractYears(value: Date, years: number) {
  const result = new Date(value);
  result.setUTCFullYear(result.getUTCFullYear() - years);
  return result;
}

function atLeastYears(first: Date | null, latest: Date | null, years: number) {
  return Boolean(first && latest && first <= subtractYears(latest, years));
}

function jobFor(row: Row, jobs: ExchangeCalendarJob[]) {
  const exact = jobs.filter(job => job.exchanges.includes(row.exchange));
  if (exact.length === 1) return exact[0];
  const country = jobs.filter(job => job.country === row.country);
  return country.length === 1 ? country[0] : null;
}

function freshness(row: Row, job: ExchangeCalendarJob | null) {
  if (row.latest_close == null || !row.latest_date) return 'NO_CURRENT_DATA';
  if (!job) return 'CONFIGURATION_CONSTRAINED';
  const latest = isoDate(row.latest_date)!;
  const expected = latestClosedTradingDate(job, AUDIT_AT);
  if (latest < expected) return 'STALE_PIPELINE';
  const clock = marketClock(job.timezone, AUDIT_AT);
  if (!isTradingDate(job, clock.date)) return 'MARKET_CLOSED';
  if (AUDIT_AT < dispatchAt(job, clock.date) && latest < clock.date) return 'WAITING_FOR_NEXT_SESSION';
  return 'CURRENT';
}

function currentState(row: Row, freshnessState: string) {
  if (row.latest_close == null || !row.latest_date) return 'CURRENT_NO_SOURCE_ROW';
  if (freshnessState === 'MARKET_CLOSED') return 'CURRENT_MARKET_CLOSED';
  if (freshnessState === 'WAITING_FOR_NEXT_SESSION') return 'CURRENT_WAITING';
  if (freshnessState === 'CONFIGURATION_CONSTRAINED') return 'CURRENT_CONFIGURATION_CONSTRAINED';
  if (freshnessState === 'STALE_PIPELINE') return 'CURRENT_STALE_PIPELINE';
  return 'CURRENT_READY';
}

function identityState(row: Row, conflicts: Set<string>) {
  if (conflicts.has(row.id)) return 'LEGACY_IDENTITY_CONFLICT';
  if (!nonBlank(row.yahoo_symbol)) return 'LEGACY_IDENTITY_SOURCE_CONSTRAINED';
  if (![row.id, row.ticker, row.exchange, row.country, row.currency, row.company_name].every(nonBlank)) return 'LEGACY_IDENTITY_PARTIAL';
  return 'LEGACY_IDENTITY_VALID';
}

function sampleClass(item: any) {
  if (item.identity !== 'LEGACY_IDENTITY_VALID' || item.current === 'CURRENT_NO_SOURCE_ROW' || item.history.rows === 0) return 'NOT_READY';
  if (item.bridge === 'BRIDGE_CANONICAL_SECURITY_MISSING') return 'SCHEMA_BLOCKED_READY';
  if (item.history.rows < 20) return 'TIME_DEPTH_CONSTRAINED_READY';
  return 'CORE_READY';
}

async function main() {
  if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) throw new Error('DATABASE_URL_NOT_CONFIGURED');
  await prisma.$queryRaw`SELECT 1`;
  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT s.id, s.ticker, s.yahoo_symbol, s.exchange, s.country, s.currency,
           s.company_name, s.sector, s.industry, s.status::text AS status,
           s.latest_close, s.latest_date, s.is_active,
           p.id AS coverage_id, p.history_rows::text AS history_rows,
           p.first_date, p.latest_date AS history_latest_date, p.last_calculated_at
    FROM stocks s
    LEFT JOIN product_coverage_snapshot p
      ON p.product_type = 'Stock' AND p.product_id = s.id
    ORDER BY s.id
  `);
  const bridgeColumn = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='stocks' AND column_name='security_id'
    ) AS present
  `);
  const schedulerLocks = await prisma.$queryRawUnsafe<any[]>(`
    SELECT job_id, owner, expires_at, updated_at
    FROM production_scheduler_locks
    ORDER BY job_id
  `);
  const activeRuns = await prisma.$queryRawUnsafe<any[]>(`
    SELECT id, job_id, exchange, run_type, status, started_at, attempted, completed, failed
    FROM production_scheduler_runs
    WHERE status='IN_PROGRESS'
    ORDER BY started_at
  `);
  const recentHistorical = await prisma.$queryRawUnsafe<any[]>(`
    SELECT DISTINCT ON (job_id) job_id, exchange, status, started_at, completed_at,
           attempted, completed, failed, exit_code, error
    FROM production_scheduler_runs
    WHERE job_id = 'stock-price-jpx-historical'
       OR exchange = 'NYSE'
       OR job_id ILIKE '%nyse%'
    ORDER BY job_id, started_at DESC
  `);
  const registry = await loadExchangeCalendarRegistry();
  const keyCounts = new Map<string, number>();
  const yahooCounts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.exchange}\u0000${row.ticker}`;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    yahooCounts.set(row.yahoo_symbol, (yahooCounts.get(row.yahoo_symbol) ?? 0) + 1);
  }
  const conflicts = new Set(rows.filter(row =>
    (keyCounts.get(`${row.exchange}\u0000${row.ticker}`) ?? 0) > 1 ||
    (yahooCounts.get(row.yahoo_symbol) ?? 0) > 1,
  ).map(row => row.id));

  const counts: Record<string, Record<string, number>> = {
    identity: {}, bridge: {}, current: {}, historyReason: {}, taxonomy: {}, provenance: {}, quality: {}, freshness: {}, sample: {},
  };
  const historyDepth = { noHistory: 0, lt20: 0, ge20: 0, ge1y: 0, ge3y: 0, ge5y: 0, ge10y: 0, ge20y: 0 };
  let historyEntities = 0;
  let historyRows = 0n;
  let earliest: Date | null = null;
  let latest: Date | null = null;
  let matrixRows = 0;
  let taxonomySector = 0;
  let taxonomyIndustry = 0;
  let currentCoverage = 0;
  let currentHistoryIntersection = 0;
  let anyCoreData = 0;
  const identityFieldCoverage: Record<string, number> = {
    id: 0, ticker: 0, providerSourceIdentity: 0, exchange: 0, country: 0, currency: 0, name: 0,
  };
  const classified: any[] = [];

  const bridgeState = bridgeColumn[0]?.present ? 'BRIDGE_IDENTIFIER_MISSING' : 'BRIDGE_CANONICAL_SECURITY_MISSING';
  for (const row of rows) {
    const rowHistory = Number(row.history_rows ?? 0);
    const historyPresent = rowHistory > 0;
    const currentPresent = row.latest_close != null && row.latest_date != null;
    const identity = identityState(row, conflicts);
    const identityFields = {
      id: nonBlank(row.id), ticker: nonBlank(row.ticker), providerSourceIdentity: nonBlank(row.yahoo_symbol),
      exchange: nonBlank(row.exchange), country: nonBlank(row.country), currency: nonBlank(row.currency), name: nonBlank(row.company_name),
    };
    const fresh = freshness(row, jobFor(row, registry.jobs));
    const current = currentState(row, fresh);
    const taxonomy = row.sector && row.industry ? 'TAXONOMY_READY' : 'TAXONOMY_PARTIAL';
    const provenance = currentPresent && historyPresent
      ? 'CORE_PROVENANCE_LEGACY_CONSTRAINED'
      : currentPresent || historyPresent ? 'CORE_PROVENANCE_PARTIAL' : 'CORE_PROVENANCE_NOT_READY';
    const quality = conflicts.has(row.id)
      ? 'QUALITY_QUARANTINED'
      : currentPresent || historyPresent ? 'QUALITY_PARTIAL' : 'QUALITY_NOT_READY';
    let historyReason: string | null = null;
    if (!historyPresent) historyReason = 'HISTORY_PIPELINE_INCOMPLETE';
    else if (rowHistory < 20 || !row.first_date || !row.history_latest_date) historyReason = 'HISTORY_TIME_CONSTRAINED';

    inc(counts.identity, identity);
    for (const [field, present] of Object.entries(identityFields)) if (present) identityFieldCoverage[field] += 1;
    inc(counts.bridge, bridgeState);
    inc(counts.current, current);
    inc(counts.taxonomy, taxonomy);
    inc(counts.provenance, provenance);
    inc(counts.quality, quality);
    inc(counts.freshness, `FRESHNESS_${fresh === 'WAITING_FOR_NEXT_SESSION' ? 'WAITING' : fresh}`);
    if (historyReason) inc(counts.historyReason, historyReason);
    if (row.coverage_id) matrixRows += 1;
    if (row.sector) taxonomySector += 1;
    if (row.industry) taxonomyIndustry += 1;
    if (currentPresent) currentCoverage += 1;
    if (currentPresent || historyPresent) anyCoreData += 1;
    if (currentPresent && historyPresent) currentHistoryIntersection += 1;
    if (historyPresent) historyEntities += 1; else historyDepth.noHistory += 1;
    historyRows += BigInt(rowHistory);
    if (rowHistory < 20) historyDepth.lt20 += 1; else historyDepth.ge20 += 1;
    if (atLeastYears(row.first_date, row.history_latest_date, 1)) historyDepth.ge1y += 1;
    if (atLeastYears(row.first_date, row.history_latest_date, 3)) historyDepth.ge3y += 1;
    if (atLeastYears(row.first_date, row.history_latest_date, 5)) historyDepth.ge5y += 1;
    if (atLeastYears(row.first_date, row.history_latest_date, 10)) historyDepth.ge10y += 1;
    if (atLeastYears(row.first_date, row.history_latest_date, 20)) historyDepth.ge20y += 1;
    if (row.first_date && (!earliest || row.first_date < earliest)) earliest = row.first_date;
    if (row.history_latest_date && (!latest || row.history_latest_date > latest)) latest = row.history_latest_date;

    classified.push({
      stockId: row.id, ticker: row.ticker, yahooSymbol: row.yahoo_symbol,
      exchange: row.exchange, country: row.country, active: row.is_active,
      identity, identityFields, missingIdentityFields: Object.entries(identityFields).filter(([, present]) => !present).map(([field]) => field),
      bridge: bridgeState, current,
      history: {
        rows: rowHistory, firstDate: isoDate(row.first_date), latestDate: isoDate(row.history_latest_date),
        depth: rowHistory === 0 ? 'NO_HISTORY' : rowHistory < 20 ? 'LT_20_OBSERVATIONS' : 'GE_20_OBSERVATIONS',
        ge1y: atLeastYears(row.first_date, row.history_latest_date, 1),
        ge3y: atLeastYears(row.first_date, row.history_latest_date, 3),
        ge5y: atLeastYears(row.first_date, row.history_latest_date, 5),
        ge10y: atLeastYears(row.first_date, row.history_latest_date, 10),
        ge20y: atLeastYears(row.first_date, row.history_latest_date, 20),
        reason: historyReason,
      },
      taxonomy: { state: taxonomy, country: Boolean(row.country), market: Boolean(row.exchange), sector: Boolean(row.sector), industry: Boolean(row.industry), securityType: false, listingType: false },
      provenance, quality, freshness: `FRESHNESS_${fresh === 'WAITING_FOR_NEXT_SESSION' ? 'WAITING' : fresh}`,
      detail: 'CLASSIFIED',
      optionalDomains: {
        fundamentals: 'SEPARATE_DOMAIN_NOT_CORE', corporateActions: 'SEPARATE_DOMAIN_SUPERVISED',
        buyback: 'SEPARATE_DOMAIN_SUPERVISED', technical: 'SEPARATE_DOMAIN_NOT_CORE',
      },
    });
  }

  const geoGroups = [
    { geo: 'US', countries: new Set(['US', 'United States']) },
    { geo: 'TW', countries: new Set(['TW', 'Taiwan']) },
    { geo: 'JP', countries: new Set(['JP', 'Japan']) },
    { geo: 'EU', countries: new Set(['DE', 'Germany', 'GB', 'United Kingdom', 'FR', 'France']) },
    { geo: 'HK', countries: new Set(['HK', 'Hong Kong']) },
  ];
  const sample: any[] = [];
  for (const group of geoGroups) {
    const candidates = classified
      .filter(item => group.countries.has(item.country) && item.identity === 'LEGACY_IDENTITY_VALID' && item.current !== 'CURRENT_NO_SOURCE_ROW' && item.history.rows >= 20)
      .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.stockId.localeCompare(b.stockId))
      .slice(0, 2);
    if (candidates.length !== 2) throw new Error(`DETAIL_SAMPLE_INCOMPLETE:${group.geo}:${candidates.length}/2`);
    for (const candidate of candidates) {
      const state = sampleClass(candidate);
      inc(counts.sample, `DETAIL_SAMPLE_${state}`);
      sample.push({ geo: group.geo, stockId: candidate.stockId, ticker: candidate.ticker, market: `${candidate.country}/${candidate.exchange}`, state });
    }
  }

  const unknowns = {
    identity: rows.length - Object.values(counts.identity).reduce((a, b) => a + b, 0),
    bridge: rows.length - Object.values(counts.bridge).reduce((a, b) => a + b, 0),
    current: rows.length - Object.values(counts.current).reduce((a, b) => a + b, 0),
    taxonomy: rows.length - Object.values(counts.taxonomy).reduce((a, b) => a + b, 0),
    provenance: rows.length - Object.values(counts.provenance).reduce((a, b) => a + b, 0),
    quality: rows.length - Object.values(counts.quality).reduce((a, b) => a + b, 0),
    freshness: rows.length - Object.values(counts.freshness).reduce((a, b) => a + b, 0),
    sample: sample.length - Object.values(counts.sample).reduce((a, b) => a + b, 0),
  };
  const unknownMatrixStates = Object.values(unknowns).slice(0, 7).reduce((a, b) => a + b, 0);
  if (rows.length !== 80_944 || matrixRows !== rows.length || Object.values(unknowns).some(value => value !== 0)) {
    throw new Error(`FAIL_CLOSED_COUNTS:${json({ rows: rows.length, matrixRows, unknowns })}`);
  }

  await mkdir(ROOT, { recursive: true });
  const classificationPath = path.join(ROOT, 'stock-core-classification.jsonl');
  const tempPath = `${classificationPath}.${process.pid}.tmp`;
  await writeFile(tempPath, classified.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  await rename(tempPath, classificationPath);
  const summary = {
    task: TASK,
    mode: 'BOUNDED_PRE_MIGRATION_CORE_RECOVERY',
    auditAt: AUDIT_AT.toISOString(),
    databaseWritePerformed: false,
    databaseDdlPerformed: false,
    migrationPerformed: false,
    classificationPath,
    totalStocks: rows.length,
    legacyStockRows: rows.length,
    activeStocks: rows.filter(row => row.is_active).length,
    currentCoverage,
    currentHistoryIntersection,
    anyCoreData,
    identityFieldCoverage,
    matrixRows,
    counts,
    history: { entities: historyEntities, rows: historyRows.toString(), earliest: isoDate(earliest), latest: isoDate(latest), ...historyDepth },
    taxonomyFields: { sector: taxonomySector, industry: taxonomyIndustry },
    unknowns: { ...unknowns, matrix: unknownMatrixStates },
    bridgePrerequisite: {
      stockSecurityIdColumnPresent: bridgeColumn[0]?.present ?? false,
      state: bridgeState,
      exactPostMigrationPrerequisites: ['stocks.security_id', 'UNIQUE_OR_VERIFIED_CARDINALITY', 'FOREIGN_KEY_TO_SECURITIES_ID', 'PRISMA_STOCK_SECURITY_RELATION', 'SECURITY_STOCK_BACKRELATION', 'EXACT_IDENTIFIER_RECONCILIATION'],
    },
    ownership: {
      activeLocks: schedulerLocks.filter(lock => new Date(lock.expires_at) > AUDIT_AT && new Date(lock.updated_at).getTime() > AUDIT_AT.getTime() - 600_000),
      staleLocks: schedulerLocks.filter(lock => new Date(lock.expires_at) <= AUDIT_AT || new Date(lock.updated_at).getTime() <= AUDIT_AT.getTime() - 600_000),
      activeRuns: activeRuns.filter(run => schedulerLocks.some(lock => lock.job_id === run.job_id && new Date(lock.expires_at) > AUDIT_AT && new Date(lock.updated_at).getTime() > AUDIT_AT.getTime() - 600_000)),
      staleOrOrphanRuns: activeRuns.filter(run => !schedulerLocks.some(lock => lock.job_id === run.job_id && new Date(lock.expires_at) > AUDIT_AT && new Date(lock.updated_at).getTime() > AUDIT_AT.getTime() - 600_000)),
      recentHistorical,
    },
    incremental: {
      current: 'EXISTING_MARKET_EVENT_ENGINE:run-production-yahoo-daily.ts',
      history: 'JPX_CONFIGURATION_CONSTRAINED;NYSE_PIPELINE_FAILURE;NO_RESTART_PER_TASK',
      scheduler: 'PARTIAL_EXISTING_CONTRACT',
    },
    sample,
    methodology: {
      history: 'INDEXED_PRODUCT_COVERAGE_SNAPSHOT;NO_118M_ROW_SCAN',
      quality: 'UNIQUE_GRAIN_AND_IDENTITY_CONSTRAINTS_VERIFIED;VALUE_LEVEL_OHLC_VOLUME_SCAN_NOT_RUN;CLASSIFIED_PARTIAL',
      provenance: 'FULL_CONTRACT_COLUMNS_ABSENT;LEGACY_OR_PARTIAL_CLASSIFICATION_ONLY',
      freshness: 'EXISTING_PRODUCTION_YAHOO_DAILY_CALENDAR_REGISTRY_AND_LATEST_CLOSED_TRADING_DATE',
    },
    completedAt: new Date().toISOString(),
  };
  await atomicJson('deterministic-sample.json', sample);
  await atomicJson('classification-summary.json', summary);
  const readback = JSON.parse(await readFile(path.join(ROOT, 'classification-summary.json'), 'utf8'));
  await atomicJson('completion-manifest.json', {
    ...readback,
    status: 'COMPLETE_READ_ONLY_CLASSIFICATION',
    coverageMatrixComplete: true,
    p0ProductionPathReady: false,
    stockCanonicalBridgeStatus: 'BLOCKED_SHARED_MIGRATION_LEDGER',
    globalSchemaGovernanceStatus: 'BLOCKED',
  });
  console.log(json({
    task: TASK, totalStocks: rows.length, currentCoverage, historyEntities,
    historyRows: historyRows.toString(), matrixRows, counts, unknowns,
    sample, output: ROOT,
  }));
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
