import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});
const ROOT = path.resolve('runtime/global-stock/p0-migration-bridge-v3');
const LOCK = path.join(ROOT, 'forensics.lock.json');
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value, null, 2);

async function atomicJson(name: string, value: unknown) {
  const target = path.join(ROOT, name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, json(value), 'utf8');
  await rename(temp, target);
}

async function acquireLock() {
  await mkdir(ROOT, { recursive: true });
  const handle = await open(LOCK, 'wx');
  await handle.writeFile(json({ pid: process.pid, scope: 'READ_ONLY_MIGRATION_RECONCILIATION', acquiredAt: now() }));
  await handle.close();
}

function sha256(content: Buffer | string) {
  return createHash('sha256').update(content).digest('hex');
}

type Effect = { kind: 'table' | 'column' | 'index' | 'type' | 'constraint'; name: string; parent?: string };

function extractEffects(sql: string): Effect[] {
  const effects: Effect[] = [];
  const add = (effect: Effect) => {
    if (!effects.some(item => item.kind === effect.kind && item.name === effect.name && item.parent === effect.parent)) effects.push(effect);
  };
  for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([A-Za-z0-9_]+)["']?/gi)) add({ kind: 'table', name: match[1] });
  for (const match of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([A-Za-z0-9_]+)["']?/gi)) add({ kind: 'index', name: match[1] });
  for (const match of sql.matchAll(/CREATE\s+TYPE\s+["']?([A-Za-z0-9_]+)["']?/gi)) add({ kind: 'type', name: match[1] });
  for (const statement of sql.split(';')) {
    const tableMatch = statement.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?([A-Za-z0-9_]+)["']?/i);
    if (!tableMatch) continue;
    for (const match of statement.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([A-Za-z0-9_]+)["']?/gi)) add({ kind: 'column', parent: tableMatch[1], name: match[1] });
    for (const match of statement.matchAll(/ADD\s+CONSTRAINT\s+["']?([A-Za-z0-9_]+)["']?/gi)) add({ kind: 'constraint', parent: tableMatch[1], name: match[1] });
  }
  return effects;
}

async function schemaReality() {
  // Sequential catalog reads deliberately stay within the small Supabase session pool.
  const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>("SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname='public'");
  const columns = await prisma.$queryRawUnsafe<Array<{ parent: string; name: string }>>("SELECT table_name AS parent, column_name AS name FROM information_schema.columns WHERE table_schema='public'");
  const indexes = await prisma.$queryRawUnsafe<Array<{ name: string }>>("SELECT indexname AS name FROM pg_catalog.pg_indexes WHERE schemaname='public'");
  const types = await prisma.$queryRawUnsafe<Array<{ name: string }>>("SELECT t.typname AS name FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'");
  const constraints = await prisma.$queryRawUnsafe<Array<{ parent: string; name: string }>>("SELECT table_name AS parent, constraint_name AS name FROM information_schema.table_constraints WHERE table_schema='public'");
  const reality = {
    tables: new Set(tables.map(item => item.name)),
    columns: new Set(columns.map(item => `${item.parent}.${item.name}`)),
    indexes: new Set(indexes.map(item => item.name)),
    types: new Set(types.map(item => item.name)),
    constraints: new Set(constraints.map(item => `${item.parent}.${item.name}`)),
  };
  const exists = (effect: Effect) => {
    if (effect.kind === 'table') return reality.tables.has(effect.name);
    if (effect.kind === 'column') return reality.columns.has(`${effect.parent}.${effect.name}`);
    if (effect.kind === 'index') return reality.indexes.has(effect.name);
    if (effect.kind === 'type') return reality.types.has(effect.name);
    return reality.constraints.has(`${effect.parent}.${effect.name}`);
  };
  return { reality, exists };
}

const DB_ONLY_EFFECTS: Record<string, Effect[]> = {
  '20260629135952_init_production_schema': [{ kind: 'table', name: 'users' }],
  '20260705054545_add_asset_layer': [{ kind: 'column', parent: 'assets', name: 'layer' }],
  '20260705100600_add_investor_questionnaire': [{ kind: 'table', name: 'investor_questionnaires' }],
  '20260705142315_verify_investor_questionnaire': [{ kind: 'table', name: 'investor_questionnaires' }],
  '20260710100000_add_asset_etf_bridge_fields': [{ kind: 'column', parent: 'etfs', name: 'asset_id' }],
  '20260710120000_add_provider_log_success_fail_counts': [{ kind: 'column', parent: 'data_provider_logs', name: 'success_count' }],
  '20260710140000_add_economic_indicator_and_data_provenance': [{ kind: 'table', name: 'economic_indicators' }],
  '20260710150000_add_provider_log_skipped_and_version': [{ kind: 'column', parent: 'data_provider_logs', name: 'skipped_count' }],
  '20260710160000_widen_economic_indicator_decimal_precision': [{ kind: 'column', parent: 'economic_indicators', name: 'latest_value' }],
  '20260711000000_add_economic_series_and_value': [{ kind: 'table', name: 'economic_series' }, { kind: 'table', name: 'economic_values' }],
  '20260711010000_add_series_tag': [{ kind: 'table', name: 'series_tags' }],
  '20260712030000_add_fund_nav_date_source': [{ kind: 'column', parent: 'funds', name: 'latest_nav_date' }],
  '20260712080000_add_market_master': [{ kind: 'table', name: 'market_masters' }],
  '20260712081750_add_market_master_sector_field': [{ kind: 'column', parent: 'market_masters', name: 'sector' }],
  '20260712230000_add_stock_platform': [{ kind: 'table', name: 'stocks' }, { kind: 'table', name: 'stock_history' }, { kind: 'table', name: 'stock_technical' }],
  '20260713140000_add_stock_backfill_flag': [{ kind: 'column', parent: 'stocks', name: 'history_backfilled_at' }],
  '20260722232853_add_data_source_registry': [{ kind: 'table', name: 'data_sources' }],
  '20260725190000_add_favorites': [{ kind: 'table', name: 'favorites' }],
  '20260726000000_add_economic_value_lineage': [{ kind: 'column', parent: 'economic_values', name: 'source' }],
  '20260726150500_add_market_index_history': [{ kind: 'table', name: 'market_history' }],
  '20260727043000_add_product_coverage_snapshot': [{ kind: 'table', name: 'product_coverage_snapshot' }],
  '20260727094000_add_stock_history_provenance': [{ kind: 'column', parent: 'stock_history', name: 'source' }, { kind: 'column', parent: 'stock_history', name: 'source_symbol' }, { kind: 'column', parent: 'stock_history', name: 'provider_method' }],
  '20260727095500_add_stock_history_import_metadata': [{ kind: 'column', parent: 'stock_history', name: 'imported_at' }, { kind: 'column', parent: 'stock_history', name: 'updated_at' }],
  '20260731103000_add_priority_universe': [{ kind: 'table', name: 'priority_universe' }],
  '20260808145500_add_bond_market_observations': [{ kind: 'table', name: 'bond_market_observations' }],
};

async function main() {
  await acquireLock();
  await prisma.$queryRaw`SELECT 1`;
  const migrationRoot = path.resolve('prisma/migrations');
  const localNames = (await readdir(migrationRoot, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort();
  const local = new Map<string, { checksum: string | null; effects: Effect[]; sqlPresent: boolean }>();
  for (const name of localNames) {
    try {
      const sqlBuffer = await readFile(path.join(migrationRoot, name, 'migration.sql'));
      const sql = sqlBuffer.toString('utf8');
      local.set(name, { checksum: sha256(sqlBuffer), effects: extractEffects(sql), sqlPresent: true });
    } catch { local.set(name, { checksum: null, effects: [], sqlPresent: false }); }
  }
  const dbRows = await prisma.$queryRawUnsafe<Array<{
    id: string; migration_name: string; checksum: string; started_at: Date; finished_at: Date | null;
    rolled_back_at: Date | null; applied_steps_count: number; logs: string | null;
  }>>('SELECT id, migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count, logs FROM "_prisma_migrations" ORDER BY started_at, id');
  const dbByName = new Map<string, typeof dbRows>();
  for (const row of dbRows) dbByName.set(row.migration_name, [...(dbByName.get(row.migration_name) ?? []), row]);
  const { reality, exists } = await schemaReality();
  const names = [...new Set([...localNames, ...dbByName.keys()])].sort();
  const census = names.map(name => {
    const localItem = local.get(name);
    const rows = dbByName.get(name) ?? [];
    const effects = localItem?.effects.length ? localItem.effects : (DB_ONLY_EFFECTS[name] ?? []);
    const evidence = effects.map(effect => ({ ...effect, present: exists(effect) }));
    const allEffectsPresent = evidence.length > 0 && evidence.every(effect => effect.present);
    const anyEffectPresent = evidence.some(effect => effect.present);
    let classification = 'UNKNOWN';
    if (rows.length > 1) classification = 'DUPLICATE_NAME';
    else if (!localItem && rows.length === 1) classification = allEffectsPresent && rows[0].finished_at ? 'DB_ONLY_VERIFIED_APPLIED' : 'DB_ONLY_UNKNOWN';
    else if (localItem && rows.length === 0) classification = allEffectsPresent ? 'LOCAL_ONLY_SCHEMA_ALREADY_PRESENT' : 'LOCAL_ONLY_NOT_APPLIED';
    else if (localItem && rows.length === 1) {
      const row = rows[0];
      if (row.rolled_back_at) classification = 'ROLLED_BACK';
      else if (!row.finished_at) classification = 'FAILED_APPLY';
      else if (localItem.checksum !== row.checksum) classification = 'CHECKSUM_MISMATCH_CONTENT_DRIFT';
      else classification = 'MATCHED';
    }
    return {
      migrationName: name, classification,
      localExists: Boolean(localItem), dbExists: rows.length > 0,
      localChecksum: localItem?.checksum ?? null,
      dbChecksums: rows.map(row => row.checksum),
      appliedAt: rows.map(row => row.finished_at), startedAt: rows.map(row => row.started_at),
      rolledBackAt: rows.map(row => row.rolled_back_at), logs: rows.map(row => row.logs),
      duplicateNameCount: rows.length,
      schemaEffectEvidenced: allEffectsPresent ? 'ALL_PRESENT' : anyEffectPresent ? 'PARTIAL_PRESENT' : evidence.length ? 'NOT_PRESENT' : 'NO_DETERMINISTIC_EFFECT_SPEC',
      schemaEvidence: evidence,
      failedPartialState: classification === 'FAILED_APPLY' && anyEffectPresent,
    };
  });
  const count = (classification: string) => census.filter(item => item.classification === classification).length;
  const currentSchema = await readFile(path.resolve('prisma/schema.prisma'));
  let generatedClientSchemaHash: string | null = null;
  try { generatedClientSchemaHash = sha256(await readFile(path.resolve('node_modules/.prisma/client/schema.prisma'))); } catch {}
  const currentSchemaHash = sha256(currentSchema);
  const manualReviewNames = new Set(census.filter(item => [
    'DB_ONLY_UNKNOWN', 'LOCAL_ONLY_NOT_APPLIED', 'LOCAL_ONLY_SCHEMA_ALREADY_PRESENT',
    'CHECKSUM_MISMATCH_CONTENT_DRIFT', 'FAILED_APPLY', 'DUPLICATE_NAME', 'ROLLED_BACK', 'UNKNOWN'
  ].includes(item.classification)).map(item => item.migrationName));
  const existingBridgeTables = [...reality.tables].filter(name => name.includes('stock') && name.includes('security'));
  const stockSecurityForeignKeys = await prisma.$queryRawUnsafe<Array<{ table_name: string; constraint_name: string; definition: string }>>(
    `SELECT c.relname AS table_name, con.conname AS constraint_name, pg_get_constraintdef(con.oid) AS definition
     FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND con.contype='f' AND pg_get_constraintdef(con.oid) ILIKE '%securities%'`
  );
  const summary = {
    task: 'GLOBAL_STOCK_P0_MIGRATION_AND_BRIDGE_RECOVERY_V3',
    migrationCounts: {
      databaseOnly: census.filter(item => item.dbExists && !item.localExists).length,
      localOnly: census.filter(item => item.localExists && !item.dbExists).length,
      checksumMismatch: count('CHECKSUM_MISMATCH_CONTENT_DRIFT'), failed: count('FAILED_APPLY'),
      duplicateNames: count('DUPLICATE_NAME'), matched: count('MATCHED'),
      dbOnlyVerifiedApplied: count('DB_ONLY_VERIFIED_APPLIED'), dbOnlyUnknown: count('DB_ONLY_UNKNOWN'),
      localOnlyNotApplied: count('LOCAL_ONLY_NOT_APPLIED'), localOnlySchemaAlreadyPresent: count('LOCAL_ONLY_SCHEMA_ALREADY_PRESENT'),
      historicalMigrationMutated: count('CHECKSUM_MISMATCH_CONTENT_DRIFT'),
      failedPartialState: census.filter(item => item.failedPartialState).length,
      manualReviewRequired: manualReviewNames.size,
      unknownMigrationState: count('UNKNOWN') + count('DB_ONLY_UNKNOWN'),
    },
    generatedClient: {
      currentSchemaHash, generatedClientSchemaHash,
      matchesCurrentSchema: generatedClientSchemaHash === currentSchemaHash,
    },
    migrationSafeGate: {
      pass: false,
      state: 'FAIL_CLOSED',
      reason: 'UNKNOWN_DB_ONLY_MIGRATIONS_CHECKSUM_DRIFT_FAILED_ROW_DUPLICATE_NAMES_AND_GENERATED_CLIENT_DRIFT',
      plan: ['NO_ACTION_VERIFIED for MATCHED/verified schema effects', 'MANUAL_REVIEW_REQUIRED for unknown, duplicate, failed, and checksum drift', 'NO_ADDITIVE_MIGRATION_UNTIL_GATE_PASS'],
    },
    bridgeReality: {
      reusableCanonicalBridgeTables: existingBridgeTables,
      securityForeignKeys: stockSecurityForeignKeys,
      schemaReused: false,
      relationCreated: false,
      canaryExecuted: false,
      reason: 'MIGRATION_SAFE_GATE_FAILED',
    },
    censusCompletedAt: now(),
  };
  await atomicJson('migration-ledger-census.json', census);
  await atomicJson('schema-reality.json', {
    tables: [...reality.tables].sort(),
    columnCount: reality.columns.size, indexCount: reality.indexes.size,
    typeCount: reality.types.size, constraintCount: reality.constraints.size,
  });
  await atomicJson('reconciliation-summary.json', summary);
  await atomicJson('completion-manifest.json', {
    ...summary,
    structuralPathReady: false,
    productionPathReady: false,
    depthGate: 'BLOCKED_MIGRATION_RECONCILIATION',
    backgroundStarted: false,
  });
  console.log(json(summary));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect().catch(() => undefined);
  await unlink(LOCK).catch(() => undefined);
});
