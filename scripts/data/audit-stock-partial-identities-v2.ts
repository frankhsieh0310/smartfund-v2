import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('runtime/global-stock/maximum-professional-recovery-v2');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const json = (value: unknown) => JSON.stringify(value, null, 2);

async function atomicJson(name: string, value: unknown) {
  await mkdir(ROOT, { recursive: true });
  const target = path.join(ROOT, name), temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${json(value)}\n`, 'utf8');
  await rename(temp, target);
}

async function providerIdentity(symbol: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const response = await fetch(url, { headers: { 'User-Agent': 'SmartFund Stock Identity Audit' }, signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) return { status: `HTTP_${response.status}`, sourceUrl: url, checksum: createHash('sha256').update(raw).digest('hex') };
    const payload = JSON.parse(raw);
    const meta = payload?.chart?.result?.[0]?.meta ?? null;
    if (!meta) return { status: 'NO_PROVIDER_META', sourceUrl: url, checksum: createHash('sha256').update(raw).digest('hex') };
    const exactSymbol = String(meta.symbol ?? '') === symbol;
    const name = String(meta.longName ?? meta.shortName ?? '').trim();
    const instrumentType = String(meta.instrumentType ?? meta.quoteType ?? '').trim().toUpperCase();
    const equity = ['EQUITY', 'STOCK'].includes(instrumentType);
    return {
      status: exactSymbol && equity && name
        ? 'EXACT_PROVIDER_IDENTITY_READY'
        : exactSymbol && equity
          ? 'EXACT_PROVIDER_EQUITY_NAME_NOT_PROVIDED'
          : exactSymbol
            ? 'EXACT_PROVIDER_NON_EQUITY'
            : 'PROVIDER_SYMBOL_MISMATCH',
      exactSymbol, providerSymbol: meta.symbol ?? null, name: name || null, instrumentType: instrumentType || null,
      exchangeName: meta.exchangeName ?? null, currency: meta.currency ?? null, sourceUrl: url,
      checksum: createHash('sha256').update(raw).digest('hex'), retrievedAt: new Date().toISOString(),
    };
  } finally { clearTimeout(timeout); }
}

async function main() {
  await prisma.$queryRaw`SELECT 1`;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; ticker: string; yahoo_symbol: string; exchange: string; country: string; currency: string; company_name: string }>>(
    `SELECT id,ticker,yahoo_symbol,exchange,country,currency,company_name FROM stocks
      WHERE BTRIM(company_name)='' ORDER BY yahoo_symbol,id LIMIT 100`,
  );
  const items = [];
  for (const row of rows) {
    let provider;
    try { provider = await providerIdentity(row.yahoo_symbol); }
    catch (error) { provider = { status: 'ACCESS_BLOCKED', error: error instanceof Error ? error.message : String(error) }; }
    const parserArtifact = /^File Creation Time:/i.test(row.ticker) || /^File Creation Time:/i.test(row.yahoo_symbol);
    const classification = parserArtifact
      ? 'IDENTITY_CONFLICT_PARSER_ARTIFACT'
      : provider.status === 'EXACT_PROVIDER_IDENTITY_READY'
      ? 'READY_FOR_BOUNDED_NAME_UPDATE'
      : provider.status === 'EXACT_PROVIDER_EQUITY_NAME_NOT_PROVIDED' ? 'SOURCE_CONSTRAINED_NAME_NOT_PROVIDED'
      : provider.status === 'EXACT_PROVIDER_NON_EQUITY' ? 'IDENTITY_CONFLICT_NON_EQUITY_IN_STOCK_UNIVERSE'
      : /HTTP_|ACCESS/.test(provider.status) ? 'SOURCE_CONSTRAINED'
      : 'IDENTITY_NOT_READY';
    items.push({ stock: row, provider, classification });
  }
  const counts = Object.fromEntries([...new Set(items.map(item => item.classification))].map(state => [state, items.filter(item => item.classification === state).length]));
  const result = { task: 'GLOBAL_STOCK_MAXIMUM_PROFESSIONAL_DEPTH_BREADTH_AND_CANONICAL_RECOVERY_V2', scope: '16_PARTIAL_IDENTITIES', rows: rows.length, items, counts, unknown: 0, databaseWritePerformed: false, completedAt: new Date().toISOString() };
  await atomicJson('identity-provider-census.json', result);
  console.log(json(result));
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
