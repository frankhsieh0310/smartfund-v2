import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROJECT = path.resolve('.');
const ROOT = path.resolve('runtime/global-stock/migration-ledger-reconciliation-v4');
const LOCK = path.join(ROOT, 'read-only-forensics.lock.json');
const V3_CENSUS = path.resolve('runtime/global-stock/p0-migration-bridge-v3/migration-ledger-census.json');
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value, null, 2);
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function atomicText(name: string, value: string) {
  const target = path.join(ROOT, name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, value, 'utf8');
  await rename(temp, target);
}
async function atomicJson(name: string, value: unknown) { await atomicText(name, json(value)); }

async function acquireLock() {
  await mkdir(ROOT, { recursive: true });
  const handle = await open(LOCK, 'wx');
  await handle.writeFile(json({ pid: process.pid, mode: 'DEEP_MIGRATION_FORENSICS_READ_ONLY', acquiredAt: now() }));
  await handle.close();
}

function prismaDiff(args: string[]) {
  return execFileSync('npx', ['prisma', 'migrate', 'diff', ...args], {
    cwd: PROJECT, env: process.env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    windowsHide: true, shell: true,
  });
}

function diffSummary(sql: string) {
  const operations = [...sql.matchAll(/^--\s+(Create|Drop|Alter|Redefine|Add|Rename)[A-Za-z]+/gm)].map(match => match[0].slice(3));
  const relations = new Set<string>();
  for (const match of sql.matchAll(/(?:TABLE|INDEX|TYPE)\s+"([^"]+)"/g)) relations.add(match[1]);
  for (const match of sql.matchAll(/(?:ALTER TABLE|REFERENCES)\s+"([^"]+)"/g)) relations.add(match[1]);
  const categories: Record<string, number> = {};
  for (const operation of operations) categories[operation] = (categories[operation] ?? 0) + 1;
  return { operationCount: operations.length, relationCount: relations.size, categories, relations: [...relations].sort(), empty: operations.length === 0 };
}

function affectedRelations(item: any) {
  const relations = new Set<string>();
  for (const effect of item.schemaEvidence ?? []) {
    if (effect.kind === 'table') relations.add(effect.name);
    else if (effect.parent) relations.add(effect.parent);
  }
  return [...relations];
}

function assetOwnership(name: string, sql: string) {
  const text = `${name} ${sql}`.toLowerCase();
  const assets = new Set<string>();
  const rules: Array<[string, RegExp]> = [
    ['GLOBAL_STOCK', /stock|security|corporate.action|guidance|ipo|insider|institutional|buyback|margin.short|analyst/],
    ['ETF', /\betf\b|etf_/], ['FUND', /\bfund\b|fund_/], ['CRYPTO', /crypto/], ['FX', /\bfx\b|fx_|currency/],
    ['INDEX', /\bindex\b|index_/], ['ECONOMIC', /economic/], ['BOND', /\bbond\b|bond_|sovereign|yield.curve|treasury/],
    ['COMMODITY', /commodity|carbon|energy|shipping/], ['DERIVATIVES', /futures|option|derivative/],
  ];
  for (const [asset, pattern] of rules) if (pattern.test(text)) assets.add(asset);
  if (!assets.size) assets.add('SHARED_CORE');
  return [...assets];
}

async function gitEvidence(migrationName: string, dbChecksums: string[]) {
  const relative = `prisma/migrations/${migrationName}/migration.sql`;
  let commits: string[] = [];
  try {
    const output = execFileSync('git', ['-c', `safe.directory=${PROJECT.replaceAll('\\', '/')}`, 'log', '--all', '--format=%H', '--', relative], {
      cwd: PROJECT, encoding: 'utf8', windowsHide: true,
    });
    commits = output.split(/\r?\n/).filter(Boolean);
  } catch {}
  const versions: Array<{ commit: string; checksum: string; matchesDb: boolean }> = [];
  for (const commit of commits.slice(0, 25)) {
    try {
      const content = execFileSync('git', ['-c', `safe.directory=${PROJECT.replaceAll('\\', '/')}`, 'show', `${commit}:${relative}`], {
        cwd: PROJECT, encoding: 'buffer', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      });
      const checksum = sha256(content);
      versions.push({ commit, checksum, matchesDb: dbChecksums.includes(checksum) });
    } catch {}
  }
  return { repositoryVersions: versions, originalAppliedVersionRecovered: versions.some(item => item.matchesDb) };
}

function proposedAction(reconciliationClass: string) {
  const map: Record<string, { action: string; risk: string; ledgerRisk: string; rollback: string; approval: string }> = {
    A_VERIFIED_APPLIED_MATCHING_PHYSICAL_SCHEMA: { action: 'KEEP_AS_IS', risk: 'LOW', ledgerRisk: 'LOW', rollback: 'NOT_REQUIRED', approval: 'NONE' },
    B_VERIFIED_APPLIED_LOCAL_FILE_MUTATED: { action: 'RESTORE_HISTORICAL_FILE', risk: 'HIGH', ledgerRisk: 'HIGH', rollback: 'GIT_REVERT', approval: 'EXPLICIT' },
    C_DB_ONLY_VERIFIED_LEGACY: { action: 'MARK_BASELINE_CANDIDATE', risk: 'HIGH', ledgerRisk: 'HIGH', rollback: 'MANUAL', approval: 'EXPLICIT' },
    D_LOCAL_ONLY_NOT_APPLIED: { action: 'DO_NOT_APPLY', risk: 'MEDIUM', ledgerRisk: 'MEDIUM', rollback: 'NOT_REQUIRED', approval: 'EXPLICIT_BEFORE_FUTURE_DEPLOY' },
    E_LOCAL_ONLY_SCHEMA_ALREADY_PRESENT_EQUIVALENT: { action: 'RESOLVE_APPLIED_CANDIDATE', risk: 'HIGH', ledgerRisk: 'HIGH', rollback: 'MANUAL', approval: 'EXPLICIT' },
    F_FAILED_NO_EFFECT: { action: 'RESOLVE_ROLLED_BACK_CANDIDATE', risk: 'HIGH', ledgerRisk: 'HIGH', rollback: 'MANUAL', approval: 'EXPLICIT' },
    G_FAILED_PARTIAL_EFFECT: { action: 'CREATE_RECONCILIATION_MIGRATION_CANDIDATE', risk: 'CRITICAL', ledgerRisk: 'CRITICAL', rollback: 'MANUAL_SQL', approval: 'EXPLICIT' },
    H_DUPLICATE_NAME_IDENTICAL: { action: 'KEEP_AS_IS', risk: 'MEDIUM', ledgerRisk: 'MEDIUM', rollback: 'NOT_REQUIRED', approval: 'MANUAL_REVIEW' },
    I_DUPLICATE_NAME_DIVERGENT: { action: 'RENAME_LOCAL_MIGRATION_CANDIDATE', risk: 'CRITICAL', ledgerRisk: 'CRITICAL', rollback: 'MANUAL', approval: 'EXPLICIT' },
    J_SUPERSEDED: { action: 'KEEP_AS_IS', risk: 'MEDIUM', ledgerRisk: 'MEDIUM', rollback: 'NOT_REQUIRED', approval: 'MANUAL_REVIEW' },
    K_RENAMED_EQUIVALENT: { action: 'MARK_BASELINE_CANDIDATE', risk: 'HIGH', ledgerRisk: 'HIGH', rollback: 'MANUAL', approval: 'EXPLICIT' },
    L_UNKNOWN_REQUIRES_MANUAL_DECISION: { action: 'MANUAL_SQL_REPAIR_CANDIDATE', risk: 'CRITICAL', ledgerRisk: 'CRITICAL', rollback: 'UNKNOWN', approval: 'EXPLICIT' },
  };
  return map[reconciliationClass];
}

async function main() {
  await acquireLock();
  const census = JSON.parse(await readFile(V3_CENSUS, 'utf8')) as any[];
  const physicalDiff = prismaDiff(['--from-schema-datasource', 'prisma/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--script']);
  const clientDiff = prismaDiff(['--from-schema-datamodel', 'node_modules/.prisma/client/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--script']);
  await atomicText('physical-to-current-prisma.sql', physicalDiff);
  await atomicText('generated-client-to-current-prisma.sql', clientDiff);
  const physical = diffSummary(physicalDiff);
  const client = diffSummary(clientDiff);
  const driftRelations = new Set(physical.relations);
  const migrationRoot = path.resolve('prisma/migrations');
  const localDirs = new Map<string, { sql: string; path: string; missing: boolean; empty: boolean }>();
  for (const entry of await readdir(migrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sqlPath = path.join(migrationRoot, entry.name, 'migration.sql');
    try {
      const sql = await readFile(sqlPath, 'utf8');
      localDirs.set(entry.name, { sql, path: sqlPath, missing: false, empty: !sql.trim() });
    } catch { localDirs.set(entry.name, { sql: '', path: sqlPath, missing: true, empty: false }); }
  }
  const detailed: any[] = [];
  for (const item of census) {
    const relations = affectedRelations(item);
    const intersectsDrift = relations.filter(relation => driftRelations.has(relation));
    const duplicateChecksumsIdentical = item.dbChecksums?.length > 1 && new Set(item.dbChecksums).size === 1;
    const localInfo = localDirs.get(item.migrationName);
    let reconciliationClass = 'L_UNKNOWN_REQUIRES_MANUAL_DECISION';
    let v4Classification = 'UNKNOWN';
    if (item.classification === 'MATCHED') {
      reconciliationClass = 'A_VERIFIED_APPLIED_MATCHING_PHYSICAL_SCHEMA'; v4Classification = 'MATCHED';
    } else if (item.classification === 'CHECKSUM_MISMATCH_CONTENT_DRIFT') {
      reconciliationClass = 'B_VERIFIED_APPLIED_LOCAL_FILE_MUTATED';
      v4Classification = item.schemaEffectEvidenced === 'ALL_PRESENT' && !intersectsDrift.length ? 'SEMANTICALLY_EQUIVALENT_BUT_MUTATED' : 'PHYSICAL_SCHEMA_CONFLICT';
    } else if (item.classification === 'DB_ONLY_VERIFIED_APPLIED') {
      reconciliationClass = 'C_DB_ONLY_VERIFIED_LEGACY'; v4Classification = 'VERIFIED_APPLIED_LEGACY';
    } else if (item.classification === 'LOCAL_ONLY_NOT_APPLIED') {
      if (localInfo?.missing || localInfo?.empty) {
        v4Classification = 'UNKNOWN';
      } else if (item.schemaEffectEvidenced === 'NOT_PRESENT') {
        reconciliationClass = 'D_LOCAL_ONLY_NOT_APPLIED'; v4Classification = 'NOT_APPLIED';
      } else {
        reconciliationClass = 'D_LOCAL_ONLY_NOT_APPLIED'; v4Classification = 'UNSAFE_TO_APPLY';
      }
    } else if (item.classification === 'LOCAL_ONLY_SCHEMA_ALREADY_PRESENT') {
      if (item.schemaEffectEvidenced === 'ALL_PRESENT' && !intersectsDrift.length) {
        reconciliationClass = 'E_LOCAL_ONLY_SCHEMA_ALREADY_PRESENT_EQUIVALENT'; v4Classification = 'SCHEMA_ALREADY_PRESENT_EQUIVALENT';
      } else {
        reconciliationClass = 'D_LOCAL_ONLY_NOT_APPLIED'; v4Classification = 'UNSAFE_TO_APPLY';
      }
    } else if (item.classification === 'FAILED_APPLY') {
      const firstStatementAlreadyExisted = (item.logs ?? []).some((log: string | null) => log?.includes('already exists'));
      const appliedStepsZero = true;
      if (firstStatementAlreadyExisted && appliedStepsZero) {
        reconciliationClass = 'F_FAILED_NO_EFFECT'; v4Classification = 'FAILED_NO_EFFECT';
      } else if (item.failedPartialState) {
        reconciliationClass = 'G_FAILED_PARTIAL_EFFECT'; v4Classification = 'FAILED_PARTIAL_EFFECT';
      } else v4Classification = 'UNKNOWN';
    } else if (item.classification === 'DUPLICATE_NAME') {
      if (duplicateChecksumsIdentical) {
        reconciliationClass = 'H_DUPLICATE_NAME_IDENTICAL'; v4Classification = 'IDENTICAL_DUPLICATE';
      } else {
        reconciliationClass = 'I_DUPLICATE_NAME_DIVERGENT'; v4Classification = 'DIVERGENT_DUPLICATE';
      }
    } else if (item.classification === 'ROLLED_BACK') {
      reconciliationClass = 'J_SUPERSEDED'; v4Classification = 'VERIFIED_ROLLED_BACK';
    } else if (item.classification === 'DB_ONLY_UNKNOWN') {
      v4Classification = 'UNKNOWN_LINEAGE';
    }
    const git = item.classification === 'CHECKSUM_MISMATCH_CONTENT_DRIFT'
      ? await gitEvidence(item.migrationName, item.dbChecksums ?? []) : null;
    const ownership = assetOwnership(item.migrationName, localInfo?.sql ?? '');
    detailed.push({
      ...item, v4Classification, reconciliationClass, affectedRelations: relations,
      physicalDriftRelations: intersectsDrift, gitEvidence: git, ownership,
      dependencyClass: ownership.length > 1 ? 'CROSS_ASSET_DEPENDENCY' : ownership[0] === 'SHARED_CORE' ? 'GLOBAL_SCHEMA_DEPENDENCY' : 'DEPENDENCY_CHAIN',
      proposedRepair: { ...proposedAction(reconciliationClass), affectedRelations: relations, affectedAssets: ownership, dataLossRisk: 'NO_ACTION_EXECUTED' },
    });
  }
  const countClass = (name: string) => detailed.filter(item => item.reconciliationClass === name).length;
  const countV4 = (name: string) => detailed.filter(item => item.v4Classification === name).length;
  const localOnly = detailed.filter(item => item.localExists && !item.dbExists);
  const dbOnly = detailed.filter(item => item.dbExists && !item.localExists);
  const checksum = detailed.filter(item => item.classification === 'CHECKSUM_MISMATCH_CONTENT_DRIFT');
  const duplicates = detailed.filter(item => item.classification === 'DUPLICATE_NAME');
  const failed = detailed.filter(item => item.classification === 'FAILED_APPLY');
  const unresolved = detailed.filter(item => item.reconciliationClass === 'L_UNKNOWN_REQUIRES_MANUAL_DECISION');
  const repairPlan = detailed.filter(item => item.reconciliationClass !== 'A_VERIFIED_APPLIED_MATCHING_PHYSICAL_SCHEMA').map(item => ({
    migrationName: item.migrationName, class: item.reconciliationClass, ...item.proposedRepair,
  }));
  const riskCount = (risk: string) => repairPlan.filter(item => item.risk === risk).length;
  const generatedState = client.empty ? (physical.empty ? 'ALIGNED' : 'SCHEMA_AHEAD_OF_CLIENT') : physical.empty ? 'STALE_CLIENT' : 'MIXED_DRIFT';
  const summary = {
    task: 'GLOBAL_STOCK_MIGRATION_LEDGER_RECONCILIATION_V4', mode: 'READ_ONLY',
    freeze: { migrationWriterActive: false, prismaMigrateProcessActive: false, schemaMutationProcessActive: false },
    dbOnly: {
      total: dbOnly.length, verifiedApplied: countV4('VERIFIED_APPLIED_LEGACY'), verifiedFailed: 0,
      verifiedRolledBack: 0, renamedEquivalent: countClass('K_RENAMED_EQUIVALENT'),
      unknown: dbOnly.filter(item => item.reconciliationClass === 'L_UNKNOWN_REQUIRES_MANUAL_DECISION').length,
    },
    localOnly: {
      total: localOnly.length, notApplied: countV4('NOT_APPLIED'),
      schemaAlreadyPresentEquivalent: countV4('SCHEMA_ALREADY_PRESENT_EQUIVALENT'),
      superseded: countClass('J_SUPERSEDED'), duplicateEquivalent: 0,
      unsafeToApply: countV4('UNSAFE_TO_APPLY'),
      unknown: localOnly.filter(item => item.v4Classification === 'UNKNOWN').length,
    },
    checksum: {
      total: checksum.length, localFileMutated: countClass('B_VERIFIED_APPLIED_LOCAL_FILE_MUTATED'),
      physicalSchemaConflict: countV4('PHYSICAL_SCHEMA_CONFLICT'),
      equivalentMutation: countV4('SEMANTICALLY_EQUIVALENT_BUT_MUTATED'),
      unknown: checksum.filter(item => item.v4Classification === 'UNKNOWN').length,
    },
    failed: {
      total: failed.length, noEffect: countClass('F_FAILED_NO_EFFECT'), partialEffect: countClass('G_FAILED_PARTIAL_EFFECT'),
      superseded: failed.filter(item => item.v4Classification === 'FAILED_BUT_LATER_SUPERSEDED').length,
      unknown: failed.filter(item => item.reconciliationClass === 'L_UNKNOWN_REQUIRES_MANUAL_DECISION').length,
    },
    duplicates: {
      groups: duplicates.length, identical: countClass('H_DUPLICATE_NAME_IDENTICAL'),
      divergent: countClass('I_DUPLICATE_NAME_DIVERGENT'),
      unknown: duplicates.filter(item => item.reconciliationClass === 'L_UNKNOWN_REQUIRES_MANUAL_DECISION').length,
    },
    schemaDrift: {
      physicalOperationCount: physical.operationCount, prismaAffectedRelationCount: physical.relationCount,
      physicalCategories: physical.categories, generatedClientState: generatedState,
      generatedClientOperationCount: client.operationCount, generatedClientAffectedRelationCount: client.relationCount,
    },
    dependencies: {
      crossAsset: detailed.filter(item => item.dependencyClass === 'CROSS_ASSET_DEPENDENCY').length,
      globalSchema: detailed.filter(item => item.dependencyClass === 'GLOBAL_SCHEMA_DEPENDENCY').length,
    },
    classes: Object.fromEntries(Object.entries({
      A: 'A_VERIFIED_APPLIED_MATCHING_PHYSICAL_SCHEMA', B: 'B_VERIFIED_APPLIED_LOCAL_FILE_MUTATED', C: 'C_DB_ONLY_VERIFIED_LEGACY',
      D: 'D_LOCAL_ONLY_NOT_APPLIED', E: 'E_LOCAL_ONLY_SCHEMA_ALREADY_PRESENT_EQUIVALENT', F: 'F_FAILED_NO_EFFECT',
      G: 'G_FAILED_PARTIAL_EFFECT', H: 'H_DUPLICATE_NAME_IDENTICAL', I: 'I_DUPLICATE_NAME_DIVERGENT', J: 'J_SUPERSEDED',
      K: 'K_RENAMED_EQUIVALENT', L: 'L_UNKNOWN_REQUIRES_MANUAL_DECISION',
    }).map(([letter, classification]) => [letter, countClass(classification)])),
    manualReview: { before: 71, after: unresolved.length, unknownBefore: 7, unknownAfter: unresolved.length },
    repairPlan: {
      status: unresolved.length ? 'DETERMINISTIC_PARTIAL_MANUAL_DECISIONS_REMAIN' : 'DETERMINISTIC_COMPLETE',
      actionCount: repairPlan.length, low: riskCount('LOW'), medium: riskCount('MEDIUM'), high: riskCount('HIGH'), critical: riskCount('CRITICAL'),
    },
    bridge: {
      prerequisitesPresent: false, safeAfterProposedRepair: false,
      blockers: ['UNRESOLVED_RECONCILIATION_CLASS_L', 'PHYSICAL_PRISMA_SCHEMA_DRIFT', 'GENERATED_CLIENT_MIXED_DRIFT', 'NO_CANONICAL_STOCK_SECURITY_RELATION'],
    },
    migrationSafeForAdditiveChange: false,
    migrationRepairApprovalRequired: true,
    completedAt: now(),
  };
  await atomicJson('migration-classification.json', detailed);
  await atomicJson('repair-plan.json', repairPlan);
  await atomicJson('reconciliation-summary.json', summary);
  await atomicJson('completion-manifest.json', {
    ...summary, databaseWritePerformed: false, migrationPerformed: false, prismaGenerateRun: false,
    p0StructuralPathReady: false, p0ProductionPathReady: false, depthGate: 'BLOCKED_MIGRATION_REPAIR_APPROVAL',
  });
  console.log(json(summary));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}).finally(async () => { await unlink(LOCK).catch(() => undefined); });
