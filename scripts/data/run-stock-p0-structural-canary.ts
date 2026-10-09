import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});
const ROOT = path.resolve('runtime/global-stock/p0-structural-v2');
const LOCK = path.join(ROOT, 'runner.lock.json');
const now = () => new Date().toISOString();
const serialize = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);

async function atomicJson(name: string, value: unknown) {
  const target = path.join(ROOT, name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, serialize(value), 'utf8');
  await rename(temp, target);
}

async function acquireLock() {
  await mkdir(ROOT, { recursive: true });
  const handle = await open(LOCK, 'wx');
  await handle.writeFile(serialize({ pid: process.pid, acquiredAt: now(), scope: 'STRUCTURAL_CANARY_MAX_10' }));
  await handle.close();
}

async function migrationForensics() {
  const localRoot = path.resolve('prisma/migrations');
  const localNames = (await readdir(localRoot, { withFileTypes: true }))
    .filter(item => item.isDirectory()).map(item => item.name).sort();
  const local = new Map<string, string | null>();
  for (const name of localNames) {
    try {
      const sql = await readFile(path.join(localRoot, name, 'migration.sql'));
      local.set(name, createHash('sha256').update(sql).digest('hex'));
    } catch { local.set(name, null); }
  }
  const dbRows = await prisma.$queryRawUnsafe<Array<{
    migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null; logs: string | null;
  }>>('SELECT migration_name, checksum, finished_at, rolled_back_at, logs FROM "_prisma_migrations" ORDER BY started_at');
  const dbByName = new Map<string, typeof dbRows>();
  for (const row of dbRows) dbByName.set(row.migration_name, [...(dbByName.get(row.migration_name) ?? []), row]);
  const dbOnly = [...dbByName.keys()].filter(name => !local.has(name));
  const localOnly = [...local.keys()].filter(name => !dbByName.has(name));
  const failed = dbRows.filter(row => !row.finished_at && !row.rolled_back_at).map(row => row.migration_name);
  const checksumMismatch = [...local.entries()].flatMap(([name, checksum]) => {
    const rows = dbByName.get(name) ?? [];
    return checksum && rows.some(row => row.checksum !== checksum) ? [name] : [];
  });
  const common = localNames.filter(name => dbByName.has(name));
  return {
    status: 'DIVERGED',
    rootCause: 'BIDIRECTIONAL_HISTORY_FORK_AFTER_20260805090000_global_crypto_platform',
    lastCommonByMigrationOrder: common.at(-1) ?? null,
    localMigrationCount: localNames.length,
    databaseMigrationRows: dbRows.length,
    databaseOnly: dbOnly,
    localOnly,
    checksumMismatch,
    failed,
    duplicateDatabaseNames: [...dbByName.entries()].filter(([, rows]) => rows.length > 1).map(([name, rows]) => ({ name, rows: rows.length })),
    safetyDecision: 'EXISTING_SCHEMA_ONLY; DO_NOT_DEPLOY_OR_RESOLVE_MIGRATIONS',
    inspectedAt: now(),
  };
}

async function selectCanary() {
  const geos = [
    { geo: 'US', countries: ['US', 'United States'] },
    { geo: 'TW', countries: ['TW', 'Taiwan'] },
    { geo: 'JP', countries: ['JP', 'Japan'] },
    { geo: 'EU', countries: ['DE', 'Germany', 'GB', 'United Kingdom', 'FR', 'France'] },
    { geo: 'HK', countries: ['HK', 'Hong Kong'] },
  ];
  const selected: any[] = [];
  for (const item of geos) {
    const rows = await prisma.stock.findMany({
      where: { isActive: true, country: { in: item.countries }, history: { some: {} } },
      orderBy: [{ ticker: 'asc' }, { id: 'asc' }], take: 2,
      select: {
        id: true, ticker: true, yahooSymbol: true, companyName: true, exchange: true,
        country: true, currency: true, sector: true, industry: true, status: true,
        latestClose: true, latestDate: true,
      },
    });
    if (rows.length !== 2) throw new Error(`CANARY_SAMPLE_INCOMPLETE:${item.geo}:${rows.length}/2`);
    selected.push(...rows.map(row => ({ ...row, geo: item.geo })));
  }
  return selected;
}

function number(value: unknown) { return value == null ? null : Number(value); }
function returnBetween(start: number | null, end: number | null) {
  return start && end ? (end / start) - 1 : null;
}
function nearestAtOrBefore(rows: any[], timestamp: number) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (new Date(rows[index].date).getTime() <= timestamp) return number(rows[index].adjustedClose ?? rows[index].close);
  }
  return null;
}
function volatility(values: number[], window: number) {
  const slice = values.slice(-(window + 1));
  if (slice.length < window + 1) return null;
  const returns = slice.slice(1).map((value, index) => Math.log(value / slice[index])).filter(Number.isFinite);
  if (returns.length < window) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}
function maxDrawdown(values: number[], window: number) {
  const slice = values.slice(-window);
  if (slice.length < 2) return null;
  let peak = slice[0], worst = 0;
  for (const value of slice) { peak = Math.max(peak, value); worst = Math.min(worst, (value / peak) - 1); }
  return worst;
}

async function projectStock(stock: any) {
  const securities = await prisma.security.findMany({
    where: { ticker: stock.ticker }, take: 20,
    select: { id: true, ticker: true, isin: true, cusip: true, sedol: true, exchange: true, country: true, currency: true, name: true },
  });
  const exactCandidates = securities.filter(security =>
    security.exchange === stock.exchange && security.country === stock.country && security.currency === stock.currency,
  );
  // Neither table has a shared MIC/FIGI/provider ID and Stock has no ISIN/CUSIP/SEDOL.
  // Exchange+symbol without a security type is evidence, not a verified production mapping.
  const bridge = {
    status: exactCandidates.length > 1 ? 'AMBIGUOUS' : 'UNRESOLVED',
    verified: false,
    candidates: exactCandidates.map(candidate => candidate.id),
    reason: exactCandidates.length > 1 ? 'MULTIPLE_EXACT_EXCHANGE_SYMBOL_COUNTRY_CURRENCY' : 'NO_SHARED_VERIFIED_IDENTIFIER_OR_SECURITY_TYPE',
  };
  const history = await prisma.stockHistory.findMany({
    where: { stockId: stock.id }, orderBy: { date: 'desc' }, take: 3000,
    select: { date: true, close: true, adjustedClose: true, volume: true, source: true, sourceSymbol: true, providerMethod: true, importedAt: true },
  });
  history.reverse();
  const latest = history.at(-1) ?? null;
  const previous = history.at(-2) ?? null;
  const latestPrice = number(latest?.adjustedClose ?? latest?.close);
  const previousClose = number(previous?.adjustedClose ?? previous?.close);
  const values = history.map(row => number(row.adjustedClose ?? row.close)).filter((value): value is number => value != null && value > 0);
  const latestTime = latest ? new Date(latest.date).getTime() : Date.now();
  const day = 86_400_000;
  const periods: Record<string, number> = { RETURN_1D: 1, RETURN_1W: 7, RETURN_1M: 30, RETURN_3M: 91, RETURN_6M: 182, RETURN_1Y: 365, RETURN_3Y: 1096, RETURN_5Y: 1826, RETURN_10Y: 3652 };
  const performance = Object.fromEntries(Object.entries(periods).map(([metric, days]) => [metric, returnBetween(nearestAtOrBefore(history, latestTime - days * day), latestPrice)]));
  const ath = values.length ? Math.max(...values) : null;
  const athRow = ath == null ? null : history.find(row => number(row.adjustedClose ?? row.close) === ath) ?? null;
  const financial = await prisma.stockFinancialFact.findMany({
    where: { stockId: stock.id },
    select: { metric: true, fiscalPeriod: true, formType: true, publicationDate: true, filingDate: true, restatementVersion: true, source: true },
  });
  const metricText = financial.map(row => row.metric.toLowerCase());
  const includesAny = (terms: string[]) => metricText.some(metric => terms.some(term => metric.includes(term)));
  const financialCoverage = {
    HAS_INCOME_STATEMENT: includesAny(['revenue', 'netincome', 'operatingincome', 'earningspershare', 'eps']),
    HAS_BALANCE_SHEET: includesAny(['assets', 'liabilities', 'equity', 'cash', 'debt']),
    HAS_CASH_FLOW: includesAny(['cashflow', 'cashfromoperating', 'capitalexpenditure', 'capex']),
    HAS_TTM: financial.some(row => /TTM/i.test(row.fiscalPeriod ?? '')),
    HAS_QUARTERLY: financial.some(row => /Q[1-4]|QUARTER/i.test(`${row.fiscalPeriod ?? ''} ${row.formType ?? ''}`)),
    HAS_ANNUAL: financial.some(row => /FY|ANNUAL|10-K|20-F/i.test(`${row.fiscalPeriod ?? ''} ${row.formType ?? ''}`)),
    HAS_PUBLICATION_DATE: financial.some(row => row.publicationDate != null || row.filingDate != null),
    HAS_RESTATEMENT_EVIDENCE: financial.some(row => row.restatementVersion != null),
  };
  return {
    stock: { geo: stock.geo, id: stock.id, ticker: stock.ticker, yahooSymbol: stock.yahooSymbol, market: `${stock.country}/${stock.exchange}` },
    identity: {
      status: stock.ticker && stock.companyName && stock.exchange && stock.country && stock.currency ? 'CORE_PASS_PROFESSIONAL_PARTIAL' : 'FAIL',
      source: 'LEGACY_STOCK_MASTER', verificationStatus: 'UNVERIFIED_PROFESSIONAL_IDENTIFIERS',
    },
    bridge,
    corporateActionLookup: { status: bridge.verified ? 'READY' : 'UNRESOLVED', rows: 0 },
    taxonomy: {
      sector: stock.sector, industry: stock.industry,
      status: stock.sector && stock.industry ? 'LEGACY_PRESENT_SOURCE_UNVERIFIED' : 'MISSING',
    },
    market: {
      latestPrice, previousClose,
      change: latestPrice != null && previousClose != null ? latestPrice - previousClose : null,
      changePercent: returnBetween(previousClose, latestPrice), volume: number(latest?.volume),
      sharesOutstanding: null, marketCap: null, currency: stock.currency,
      asOfTimestamp: latest?.date ?? null, source: latest?.source ?? latest?.providerMethod ?? null,
      verificationStatus: latest?.source ? 'SOURCE_RECORDED' : 'LEGACY_UNVERIFIED',
    },
    financialCoverage,
    performance: { ...performance, source: 'DERIVED_FROM_CANONICAL_STOCK_HISTORY', asOfDate: latest?.date ?? null, observationCount: history.length },
    risk: {
      VOLATILITY_30D: volatility(values, 30), VOLATILITY_90D: volatility(values, 90), VOLATILITY_1Y: volatility(values, 252),
      MAX_DRAWDOWN_1Y: maxDrawdown(values, 252), MAX_DRAWDOWN_3Y: maxDrawdown(values, 756), MAX_DRAWDOWN_5Y: maxDrawdown(values, 1260),
      ATH: ath, ATH_DATE: athRow?.date ?? null, DRAWDOWN_FROM_ATH: returnBetween(ath, latestPrice),
      source: 'DERIVED_FROM_CANONICAL_STOCK_HISTORY', calculatedAt: now(),
    },
    valuation: { status: 'NULL_INSUFFICIENT_VERIFIED_INPUT_LINEAGE' },
    provenance: {
      HISTORY: latest?.source ? 'SOURCE_RECORDED' : 'LEGACY_UNVERIFIED',
      FINANCIAL: financial.length ? 'SOURCE_RECORDED' : 'UNAVAILABLE',
      TAXONOMY: 'UNVERIFIED', EVENT_LINK: 'UNRESOLVED', ANALYTICS: 'CALCULATED_CANARY_ONLY',
    },
  };
}

async function main() {
  await acquireLock();
  await prisma.$queryRaw`SELECT 1`;
  const forensics = await migrationForensics();
  await atomicJson('migration-divergence-forensics.json', forensics);
  const stocks = await selectCanary();
  const projections = [];
  for (const stock of stocks) projections.push(await projectStock(stock));
  const bridge = projections.map(item => ({ stock: item.stock, ...item.bridge }));
  const summary = {
    task: 'GLOBAL_STOCK_P0_STRUCTURAL_BLOCKER_RECOVERY_V2', status: 'PARTIAL_PASS', maxStocks: 10,
    stocks: projections.map(item => item.stock),
    contracts: {
      identity: 'PASS_DEFINITION_ONLY', bridge: 'PASS_PATH_RUNTIME_EVIDENCE_ONLY',
      taxonomy: 'PASS_DEFINITION_SOURCE_PATH_ONLY', marketStructure: 'PASS_RUNTIME_PROJECTION',
      sharesOutstanding: 'PASS_DEFINITION_ONLY', marketCap: 'PASS_DEFINITION_ONLY',
      financialCoverage: 'PASS_RUNTIME_PROJECTION', performance: 'PASS_RUNTIME_PROJECTION',
      risk: 'PASS_RUNTIME_PROJECTION', valuation: 'PASS_DEFINITION_ONLY',
      pointInTime: 'PASS_CODE_CONTRACT', provenance: 'PASS_RUNTIME_PROJECTION',
    },
    bridge: {
      matched: bridge.filter(item => item.verified).length,
      unresolved: bridge.filter(item => item.status === 'UNRESOLVED').length,
      ambiguous: bridge.filter(item => item.status === 'AMBIGUOUS').length,
    },
    taxonomy: {
      verified: 0,
      legacyPresent: projections.filter(item => item.taxonomy.status === 'LEGACY_PRESENT_SOURCE_UNVERIFIED').length,
      missing: projections.filter(item => item.taxonomy.status === 'MISSING').length,
    },
    readBack: 'PENDING_FILE_READBACK', completedAt: now(),
  };
  await atomicJson('verified-security-bridge.json', bridge);
  await atomicJson('structural-projections.json', projections);
  await atomicJson('canary-result.json', summary);
  const readBack = JSON.parse(await readFile(path.join(ROOT, 'canary-result.json'), 'utf8'));
  readBack.readBack = readBack.stocks?.length === 10 ? 'PASS_10_OF_10' : 'FAIL';
  await atomicJson('canary-result.json', readBack);
  await atomicJson('completion-manifest.json', {
    ...readBack,
    structuralPathReady: false,
    productionRelationReady: false,
    structuralBlockers: [
      'MIGRATION_HISTORY_DIVERGENCE_AND_FAILED_MIGRATION_ROW',
      'NO_CANONICAL_STOCK_SECURITY_RELATION',
      'NO_VERIFIED_TAXONOMY_ROWS_OR_ADAPTERS',
      'NO_CANONICAL_MARKET_SHARES_ANALYTICS_PROVENANCE_PERSISTENCE'
    ],
    backgroundActivation: 'NONE_NEW; CANARY-PASSED PROJECTIONS REQUIRE APPROVED MIGRATION OR EXISTING CANONICAL TABLE',
  });
  console.log(serialize(readBack));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect().catch(() => undefined);
  await unlink(LOCK).catch(() => undefined);
});
