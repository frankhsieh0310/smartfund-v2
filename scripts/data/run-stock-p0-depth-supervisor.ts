import { PrismaClient } from '@prisma/client';
import { mkdir, open, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

const ROOT = path.resolve('runtime/automation/global-stock-p0-depth');
const FILES = {
  lock: path.join(ROOT, 'runner.lock.json'),
  pid: path.join(ROOT, 'pid.json'),
  checkpoint: path.join(ROOT, 'checkpoint.json'),
  heartbeat: path.join(ROOT, 'heartbeat.json'),
  failureQueue: path.join(ROOT, 'failure-queue.json'),
  queue: path.join(ROOT, 'queue.json'),
  manifest: path.join(ROOT, 'completion-manifest.json'),
  progress: path.join(ROOT, 'progress.json'),
  canary: path.join(ROOT, 'canary-result.json'),
};

const CANARY = process.argv.includes('--canary');
const BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.STOCK_P0_BATCH_SIZE ?? 25)));
const MAX_RETRIES = 3;
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);

async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, json(value), 'utf8');
  await rename(temp, file);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return fallback; }
}

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireLock() {
  await mkdir(ROOT, { recursive: true });
  try {
    const handle = await open(FILES.lock, 'wx');
    await handle.writeFile(json({ pid: process.pid, acquiredAt: now(), domain: 'HISTORY_COVERAGE_CENSUS' }));
    await handle.close();
  } catch (error: any) {
    const owner = await readJson<{ pid?: number }>(FILES.lock, {});
    if (owner.pid && pidAlive(owner.pid)) throw new Error(`DUPLICATE_WRITER:${owner.pid}`);
    throw new Error(`STALE_LOCK_REQUIRES_REVIEW:${error?.message ?? error}`);
  }
  await atomicJson(FILES.pid, { pid: process.pid, startedAt: now(), mode: CANARY ? 'CANARY' : 'BACKGROUND' });
}

async function releaseLock() {
  const owner = await readJson<{ pid?: number }>(FILES.lock, {});
  if (owner.pid === process.pid) await unlink(FILES.lock).catch(() => undefined);
}

async function retry<T>(label: string, task: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try { return await task(); } catch (error) {
      last = error;
      if (attempt < MAX_RETRIES) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(`${label}:${last instanceof Error ? last.message : String(last)}`);
}

type StockRow = {
  id: string; ticker: string; yahooSymbol: string; exchange: string; country: string;
  currency: string; companyName: string; sector: string | null; industry: string | null;
  latestClose: unknown; latestDate: Date | null;
};

async function upsertCoverage(stocks: StockRow[]) {
  if (!stocks.length) return [];
  const grouped = await prisma.stockHistory.groupBy({
    by: ['stockId'],
    where: { stockId: { in: stocks.map(stock => stock.id) } },
    _count: { _all: true },
    _min: { date: true },
    _max: { date: true },
  });
  const byId = new Map(grouped.map(row => [row.stockId, row]));
  const calculatedAt = new Date();
  await prisma.$transaction(stocks.map(stock => {
    const coverage = byId.get(stock.id);
    return prisma.productCoverageSnapshot.upsert({
      where: { productType_productId: { productType: 'Stock', productId: stock.id } },
      create: {
        productType: 'Stock', productId: stock.id,
        historyRows: BigInt(coverage?._count._all ?? 0),
        firstDate: coverage?._min.date ?? null,
        latestDate: coverage?._max.date ?? null,
        lastCalculatedAt: calculatedAt,
      },
      update: {
        historyRows: BigInt(coverage?._count._all ?? 0),
        firstDate: coverage?._min.date ?? null,
        latestDate: coverage?._max.date ?? null,
        lastCalculatedAt: calculatedAt,
        version: { increment: 1 },
      },
    });
  }));
  return stocks.map(stock => {
    const coverage = byId.get(stock.id);
    const rows = coverage?._count._all ?? 0;
    return {
      stockId: stock.id, ticker: stock.ticker, market: `${stock.country}/${stock.exchange}`,
      rows, firstDate: coverage?._min.date ?? null, latestDate: coverage?._max.date ?? null,
      sourceState: rows > 0 ? 'AVAILABLE' : 'SOURCE_NOT_PROVIDED',
    };
  });
}

async function selectCanary() {
  const geos = [
    { label: 'US', countries: ['US', 'United States'] },
    { label: 'TW', countries: ['TW', 'Taiwan'] },
    { label: 'JP', countries: ['JP', 'Japan'] },
    { label: 'DE', countries: ['DE', 'Germany'] },
    { label: 'HK', countries: ['HK', 'Hong Kong'] },
  ];
  const selected: Array<StockRow & { geo: string }> = [];
  for (const geo of geos) {
    const stock = await prisma.stock.findFirst({
      where: { isActive: true, country: { in: geo.countries }, history: { some: {} } },
      orderBy: [{ ticker: 'asc' }, { id: 'asc' }],
      select: {
        id: true, ticker: true, yahooSymbol: true, exchange: true, country: true,
        currency: true, companyName: true, sector: true, industry: true,
        latestClose: true, latestDate: true,
      },
    });
    if (!stock) throw new Error(`CANARY_CANDIDATE_NOT_FOUND:${geo.label}`);
    selected.push({ ...stock, geo: geo.label });
  }
  return selected;
}

async function runCanary() {
  const selected = await selectCanary();
  const coverage = await upsertCoverage(selected);
  const ids = selected.map(stock => stock.id);
  const readback = await prisma.productCoverageSnapshot.count({
    where: { productType: 'Stock', productId: { in: ids } },
  });
  const asKnownAt = new Date();
  const financialKnown = await prisma.stockFinancialFact.groupBy({
    by: ['stockId'],
    where: {
      stockId: { in: ids },
      OR: [
        { publicationDate: { lte: asKnownAt } },
        { publicationDate: null, filingDate: { lte: asKnownAt } },
      ],
    },
    _count: { _all: true },
  });
  const result = {
    status: readback === selected.length ? 'PASSED' : 'FAILED',
    domain: 'HISTORY_COVERAGE_CENSUS',
    maxSymbols: 5,
    symbols: selected.map(stock => ({
      geo: stock.geo, id: stock.id, ticker: stock.ticker, yahooSymbol: stock.yahooSymbol,
      market: `${stock.country}/${stock.exchange}`,
      professionalIdentity: Boolean(stock.companyName && stock.exchange && stock.country && stock.currency),
      taxonomyPresent: Boolean(stock.sector && stock.industry),
      latestPresent: Boolean(stock.latestDate && stock.latestClose != null),
      history: coverage.find(item => item.stockId === stock.id),
      pointInTimeFinancialFacts: financialKnown.find(item => item.stockId === stock.id)?._count._all ?? 0,
    })),
    writes: { table: 'product_coverage_snapshot', rowsReadBack: readback, historicalRowsWritten: 0 },
    completedAt: now(),
  };
  await atomicJson(FILES.canary, result);
  await atomicJson(FILES.manifest, result);
  if (result.status !== 'PASSED') throw new Error(`CANARY_READBACK_FAILED:${readback}/${selected.length}`);
  return result;
}

async function runBackground() {
  const checkpoint = await readJson<{ lastId: string | null; processed: number; failed: number }>(
    FILES.checkpoint, { lastId: null, processed: 0, failed: 0 },
  );
  const failures = await readJson<any[]>(FILES.failureQueue, []);
  await atomicJson(FILES.queue, {
    domain: 'HISTORY_COVERAGE_CENSUS', status: 'RUNNING', batchSize: BATCH_SIZE,
    resumeFrom: checkpoint.lastId, updatedAt: now(),
  });
  while (true) {
    const stocks = await retry('LOAD_BATCH', () => prisma.stock.findMany({
      where: { isActive: true, ...(checkpoint.lastId ? { id: { gt: checkpoint.lastId } } : {}) },
      orderBy: { id: 'asc' }, take: BATCH_SIZE,
      select: {
        id: true, ticker: true, yahooSymbol: true, exchange: true, country: true,
        currency: true, companyName: true, sector: true, industry: true,
        latestClose: true, latestDate: true,
      },
    }));
    if (!stocks.length) break;
    try {
      await retry(`COVERAGE_BATCH:${stocks[0].id}`, () => upsertCoverage(stocks));
      checkpoint.processed += stocks.length;
    } catch (error) {
      checkpoint.failed += stocks.length;
      failures.push({
        ids: stocks.map(stock => stock.id), stage: 'HISTORY_COVERAGE_CENSUS',
        error: error instanceof Error ? error.message : String(error), retryable: true, at: now(),
      });
      await atomicJson(FILES.failureQueue, failures);
    }
    checkpoint.lastId = stocks.at(-1)!.id;
    await atomicJson(FILES.checkpoint, { ...checkpoint, updatedAt: now() });
    await atomicJson(FILES.heartbeat, {
      pid: process.pid, status: 'RUNNING', currentStage: 'HISTORY_COVERAGE_CENSUS',
      currentMarket: `${stocks.at(-1)!.country}/${stocks.at(-1)!.exchange}`,
      processed: checkpoint.processed, failed: checkpoint.failed, updatedAt: now(),
    });
    await atomicJson(FILES.progress, {
      asset: 'STOCK', status: 'RUNNING', current_stage: 'HISTORY_COVERAGE_CENSUS',
      current_country: stocks.at(-1)!.country, rows: checkpoint.processed,
      coverage: { completed: checkpoint.processed, total: null },
      auto_continuing: true, updated_at: now(), eta: null,
    });
  }
  const completion = {
    asset: 'STOCK', domain: 'HISTORY_COVERAGE_CENSUS', status: 'COMPLETE',
    processed: checkpoint.processed, failed: checkpoint.failed,
    nextStage: 'P0_DOMAINS_REQUIRING_MIGRATION_REVIEW', completedAt: now(),
  };
  await atomicJson(FILES.manifest, completion);
  await atomicJson(FILES.queue, { ...completion, autoContinuing: false });
  await atomicJson(FILES.heartbeat, { pid: process.pid, status: 'COMPLETE', updatedAt: now() });
  await atomicJson(FILES.progress, {
    asset: 'STOCK', status: 'PRODUCTION_COMPLETE_WITH_GAPS',
    current_stage: 'P0_DOMAINS_REQUIRING_MIGRATION_REVIEW', current_country: null,
    rows: checkpoint.processed, coverage: { completed: checkpoint.processed, total: checkpoint.processed },
    auto_continuing: false, updated_at: now(), eta: null,
  });
}

async function main() {
  await acquireLock();
  await prisma.$queryRaw`SELECT 1`;
  if (CANARY) console.log(json(await runCanary()));
  else await runBackground();
}

main()
  .catch(async error => {
    const failure = { pid: process.pid, status: 'CRASHED', error: error instanceof Error ? error.message : String(error), at: now() };
    await atomicJson(FILES.heartbeat, failure).catch(() => undefined);
    await atomicJson(FILES.manifest, failure).catch(() => undefined);
    console.error(failure);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await releaseLock().catch(() => undefined);
  });
