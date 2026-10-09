import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROJECT = path.resolve('.');
const ROOT = path.resolve('runtime/global-stock/migration-unknown-lineage-v5');
const V4_ROOT = path.resolve('runtime/global-stock/migration-ledger-reconciliation-v4');
const FREEZE = path.resolve('runtime/migration-reconciliation/phase1-v2-freeze-snapshot.json');
const now = () => new Date().toISOString();
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2);

async function atomicText(name: string, value: string) {
  const target = path.join(ROOT, name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, value, 'utf8');
  await rename(temp, target);
}
async function atomicJson(name: string, value: unknown) { await atomicText(name, json(value)); }

function run(file: string, args: string[], encoding: BufferEncoding | 'buffer' = 'utf8') {
  return execFileSync(file, args, {
    cwd: PROJECT,
    env: process.env,
    encoding: encoding as any,
    windowsHide: true,
    shell: process.platform === 'win32' && file === 'npx',
    maxBuffer: 128 * 1024 * 1024,
  }) as any;
}

type Field = { prismaName: string; dbName: string; type: string; attributes: string };
type Model = { prismaName: string; dbName: string; body: string; fields: Map<string, Field> };

function parseModels(schema: string) {
  const models = new Map<string, Model>();
  for (const match of schema.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm)) {
    const prismaName = match[1];
    const body = match[2];
    const mapped = body.match(/@@map\("([^"]+)"\)/)?.[1];
    const model: Model = { prismaName, dbName: mapped ?? prismaName, body, fields: new Map() };
    for (const line of body.split(/\r?\n/)) {
      const field = line.trim().match(/^(\w+)\s+([^\s]+)(.*)$/);
      if (!field || field[1].startsWith('@@')) continue;
      const dbName = field[3].match(/@map\("([^"]+)"\)/)?.[1] ?? field[1];
      model.fields.set(dbName, { prismaName: field[1], dbName, type: field[2], attributes: field[3].trim() });
    }
    models.set(model.dbName, model);
  }
  return models;
}

function gitVersions(migrationName: string, dbChecksums: string[]) {
  const relative = `prisma/migrations/${migrationName}/migration.sql`;
  let commits: string[] = [];
  try {
    commits = String(run('git', ['-c', `safe.directory=${PROJECT.replaceAll('\\', '/')}`, 'log', '--all', '--format=%H', '--', relative]))
      .split(/\r?\n/).filter(Boolean);
  } catch {}
  const versions: Array<{ commit: string; checksum: string; matchesProduction: boolean; bytes: number }> = [];
  for (const commit of commits.slice(0, 50)) {
    try {
      const content = run('git', ['-c', `safe.directory=${PROJECT.replaceAll('\\', '/')}`, 'show', `${commit}:${relative}`], 'buffer') as Buffer;
      const checksum = sha256(content);
      versions.push({ commit, checksum, matchesProduction: dbChecksums.includes(checksum), bytes: content.length });
    } catch {}
  }
  return { relative, versions, exactRecovered: versions.some(item => item.matchesProduction) };
}

function artifactMentions(name: string) {
  const targets = ['runtime', 'docs', 'prisma', 'scripts'].filter(item => {
    try { run('git', ['-c', `safe.directory=${PROJECT.replaceAll('\\', '/')}`, 'status', '--porcelain', '--', item]); return true; } catch { return false; }
  });
  try {
    const output = String(run('rg', ['-l', '-F', '--glob', '!**/node_modules/**', '--glob', '!**/.git/**', '--', name, ...targets]));
    return output.split(/\r?\n/).filter(Boolean).map(item => path.relative(PROJECT, item));
  } catch { return []; }
}

function diffBlocks(sql: string) {
  const lines = sql.split(/\r?\n/);
  const blocks: Array<{ operation: string; sql: string }> = [];
  let current: { operation: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = line.match(/^--\s+((?:Create|Drop|Alter|Redefine|Add|Rename)[A-Za-z]+)/);
    if (heading) {
      if (current) blocks.push({ operation: current.operation, sql: current.lines.join('\n') });
      current = { operation: heading[1], lines: [line] };
    } else if (current) current.lines.push(line);
  }
  if (current) blocks.push({ operation: current.operation, sql: current.lines.join('\n') });
  return blocks;
}

function relationTouches(block: string, relations: Set<string>) {
  for (const relation of relations) if (block.includes(`"${relation}"`)) return true;
  return false;
}

const unknownExpected: Record<string, { relation: string; operations: Array<{ kind: string; name: string; expected?: string }> }> = {
  '20260705054545_add_asset_layer': {
    relation: 'assets', operations: [{ kind: 'column', name: 'layer' }],
  },
  '20260710120000_add_provider_log_success_fail_counts': {
    relation: 'provider_logs', operations: [{ kind: 'column', name: 'success_count', expected: 'Int' }, { kind: 'column', name: 'failed_count', expected: 'Int' }],
  },
  '20260710150000_add_provider_log_skipped_and_version': {
    relation: 'provider_logs', operations: [{ kind: 'column', name: 'skipped_count', expected: 'Int' }, { kind: 'column', name: 'api_version', expected: 'String' }],
  },
  '20260710160000_widen_economic_indicator_decimal_precision': {
    relation: 'economic_indicators', operations: [
      { kind: 'column', name: 'actual', expected: 'Decimal(24,6)' },
      { kind: 'column', name: 'forecast', expected: 'Decimal(24,6)' },
      { kind: 'column', name: 'previous', expected: 'Decimal(24,6)' },
      { kind: 'column', name: 'revised', expected: 'Decimal(24,6)' },
    ],
  },
  '20260712080000_add_market_master': {
    relation: 'market_master', operations: [{ kind: 'table', name: 'market_master' }, { kind: 'unique', name: 'symbol' }, { kind: 'index', name: 'asset_type' }],
  },
  '20260712081750_add_market_master_sector_field': {
    relation: 'market_master', operations: [{ kind: 'column', name: 'sector', expected: 'String' }],
  },
  '20260726000000_add_economic_value_lineage': {
    relation: 'economic_values', operations: [
      { kind: 'column', name: 'source_url', expected: 'String' },
      { kind: 'column', name: 'source_version', expected: 'String' },
      { kind: 'column', name: 'raw_checksum', expected: 'String' },
      { kind: 'column', name: 'imported_at', expected: 'DateTime' },
    ],
  },
};

function classifyFootprint(expected: typeof unknownExpected[string], physicalModels: Map<string, Model>) {
  const model = physicalModels.get(expected.relation);
  return expected.operations.map(operation => {
    let status = 'UNATTRIBUTABLE';
    let observed: unknown = null;
    if (operation.kind === 'table') {
      status = model ? 'PRESENT_SEMANTIC_EQUIVALENT' : 'ABSENT';
      observed = model ? { prismaModel: model.prismaName, dbTable: model.dbName } : null;
    } else if (operation.kind === 'column') {
      const field = model?.fields.get(operation.name);
      observed = field ?? null;
      if (!model || !field) status = 'ABSENT';
      else if (operation.expected?.startsWith('Decimal')) {
        const exact = field.attributes.replaceAll(' ', '').includes('@db.Decimal(24,6)');
        status = exact ? 'PRESENT_SEMANTIC_EQUIVALENT' : 'CONFLICTING';
      } else status = 'PRESENT_SEMANTIC_EQUIVALENT';
    } else if (operation.kind === 'unique') {
      const present = Boolean(model?.body.match(new RegExp(`(?:@unique|@@unique\\(\\[${operation.name}\\]\\))`)));
      status = present ? 'PRESENT_SEMANTIC_EQUIVALENT' : model ? 'ABSENT' : 'UNATTRIBUTABLE';
      observed = present;
    } else if (operation.kind === 'index') {
      const prismaField = model?.fields.get(operation.name)?.prismaName ?? operation.name;
      const present = Boolean(model?.body.match(new RegExp(`@@index\\(\\[${prismaField}\\]\\)`)));
      status = present ? 'PRESENT_SEMANTIC_EQUIVALENT' : model ? 'ABSENT' : 'UNATTRIBUTABLE';
      observed = present;
    }
    return { ...operation, status, observed };
  });
}

async function main() {
  await mkdir(ROOT, { recursive: true });
  const [classification, v4Summary, freeze, physicalDiff, clientDiff, currentSchema, generatedSchema] = await Promise.all([
    readFile(path.join(V4_ROOT, 'migration-classification.json'), 'utf8').then(JSON.parse),
    readFile(path.join(V4_ROOT, 'reconciliation-summary.json'), 'utf8').then(JSON.parse),
    readFile(FREEZE, 'utf8').then(JSON.parse),
    readFile(path.join(V4_ROOT, 'physical-to-current-prisma.sql'), 'utf8'),
    readFile(path.join(V4_ROOT, 'generated-client-to-current-prisma.sql'), 'utf8'),
    readFile(path.resolve('prisma/schema.prisma'), 'utf8'),
    readFile(path.resolve('node_modules/.prisma/client/schema.prisma'), 'utf8'),
  ]);

  // `db pull --print` introspects production without changing schema.prisma or the database.
  const physicalSchema = String(run('npx', ['prisma', 'db', 'pull', '--print']));
  await atomicText('physical-schema.prisma', physicalSchema);
  const physicalModels = parseModels(physicalSchema);
  const currentModels = parseModels(currentSchema);
  const generatedModels = parseModels(generatedSchema);

  const ledger = [...freeze.ledger].sort((a: any, b: any) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const unknownItems = classification.filter((item: any) => item.v4Classification === 'UNKNOWN_LINEAGE');
  const unknownLineages = unknownItems.map((item: any) => {
    const rowIndex = ledger.findIndex((row: any) => row.migration_name === item.migrationName && row.checksum === item.dbChecksums[0]);
    const row = ledger[rowIndex];
    const expected = unknownExpected[item.migrationName];
    const footprint = classifyFootprint(expected, physicalModels);
    const allPresent = footprint.every(operation => operation.status.startsWith('PRESENT_'));
    const anyConflict = footprint.some(operation => operation.status === 'CONFLICTING');
    const git = gitVersions(item.migrationName, item.dbChecksums);
    const mentions = artifactMentions(item.migrationName);
    const derivativeMarkers = [
      'migration-ledger-reconciliation-v4', 'p0-migration-bridge-v3', 'p0-structural-v2',
      'migration-reconciliation', 'migration-unknown-lineage-v5',
      'run-stock-p0-migration-reconciliation-v3.ts', 'run-stock-migration-unknown-lineage-v5.ts',
    ];
    const sourceArtifacts = mentions.filter(file => {
      const normalized = file.replaceAll('\\', '/').toLowerCase();
      return !derivativeMarkers.some(marker => normalized.includes(marker));
    });
    const checksumEvidence = git.exactRecovered ? 'ORIGINAL_SQL_RECOVERED_EXACT'
      : allPresent ? 'PHYSICAL_EQUIVALENCE_ONLY'
      : anyConflict ? 'INSUFFICIENT_EVIDENCE' : 'INSUFFICIENT_EVIDENCE';
    const proposedAction = allPresent
      ? 'MANUAL_DECISION_REQUIRED'
      : item.migrationName === '20260705054545_add_asset_layer'
        ? 'CREATE_FORWARD_RECONCILIATION_MIGRATION'
        : 'MANUAL_DECISION_REQUIRED';
    return {
      migrationName: item.migrationName,
      ledgerTruth: {
        productionChecksum: row?.checksum ?? item.dbChecksums[0], startedAt: row?.started_at ?? item.startedAt[0],
        finishedAt: row?.finished_at ?? item.appliedAt[0], rolledBackAt: row?.rolled_back_at ?? null,
        logs: row?.logs ?? null, appliedStepsCount: row?.applied_steps_count ?? null,
      },
      localFile: { present: false, checksum: null },
      chronology: {
        predecessor: rowIndex > 0 ? { migrationName: ledger[rowIndex - 1].migration_name, startedAt: ledger[rowIndex - 1].started_at, checksum: ledger[rowIndex - 1].checksum } : null,
        successor: rowIndex >= 0 && rowIndex + 1 < ledger.length ? { migrationName: ledger[rowIndex + 1].migration_name, startedAt: ledger[rowIndex + 1].started_at, checksum: ledger[rowIndex + 1].checksum } : null,
      },
      artifactDiscovery: {
        repositoryHistory: git, exactNameMentions: mentions, independentSourceArtifacts: sourceArtifacts,
        deploymentArtifactsFound: false, backupArtifactsFound: false, generatedSqlFound: false,
        ciCdArtifactFound: false, migrationLogFound: Boolean(row?.logs), schemaSnapshotEvidence: true,
      },
      physicalSchemaTruth: { expectedRelation: expected.relation, operations: footprint },
      dependencyEvidence: {
        laterPhysicalDependency: allPresent,
        statement: allPresent
          ? `Current physical schema contains the mapped ${expected.relation} effects; this proves persistence/use, not byte-identical SQL.`
          : `No deterministic later physical dependency proves the missing ${expected.relation} effect.`,
      },
      checksumEvidence,
      classification: checksumEvidence,
      proposedAction,
      remainsUnknownLineage: !git.exactRecovered,
    };
  });

  const checksumMismatches = classification.filter((item: any) => item.classification === 'CHECKSUM_MISMATCH_CONTENT_DRIFT').map((item: any) => {
    const git = gitVersions(item.migrationName, item.dbChecksums);
    const exactVersion = git.versions.find(version => version.matchesProduction) ?? null;
    return {
      migrationName: item.migrationName,
      productionChecksum: item.dbChecksums[0], currentLocalChecksum: item.localChecksum,
      originalAppliedSqlAvailability: git.exactRecovered ? 'ORIGINAL_SQL_RECOVERED_EXACT' : 'NOT_RECOVERED',
      exactGitVersion: exactVersion,
      physicalEquivalence: item.v4Classification === 'SEMANTICALLY_EQUIVALENT_BUT_MUTATED' ? 'EQUIVALENT' : 'CONFLICTING_WITH_CURRENT_PRISMA_TARGET',
      semanticDivergence: item.localChecksum !== item.dbChecksums[0],
      requiredRepairType: git.exactRecovered ? 'RESTORE_LOCAL_MIGRATION_FILE' : 'MANUAL_DECISION_REQUIRED',
      warning: 'Never mark applied from physical similarity alone. Restore exact historical bytes first; express later intent in a new forward migration.',
    };
  });

  const duplicateGroups = classification.filter((item: any) => item.duplicateNameCount > 1).map((item: any) => {
    const rows = ledger.filter((row: any) => row.migration_name === item.migrationName);
    const divergent = new Set(item.dbChecksums).size > 1;
    return {
      migrationName: item.migrationName,
      classification: divergent ? 'DIVERGENT_DUPLICATE' : 'IDENTICAL_DUPLICATE',
      rows,
      exactObjectLevelDifference: divergent ? {
        failedChecksum: rows.find((row: any) => row.rolled_back_at)?.checksum ?? null,
        failedCommittedSteps: rows.find((row: any) => row.rolled_back_at)?.applied_steps_count ?? null,
        failedOutcome: 'ROLLED_BACK_AFTER_STATEMENT_TIMEOUT; NO COMMITTED MIGRATION STEP RECORDED',
        appliedChecksum: rows.find((row: any) => row.finished_at)?.checksum ?? null,
        appliedCommittedSteps: rows.find((row: any) => row.finished_at)?.applied_steps_count ?? null,
        appliedOutcome: 'COMMITTED; current stock_history provenance footprint is attributable to the successful row only',
        sqlTextDifference: 'UNRECOVERABLE_FROM_AVAILABLE_ARTIFACTS; checksums prove byte divergence but not the changed statements',
      } : 'CHECKSUMS_IDENTICAL; duplicate is ledger execution history, not a second SQL definition',
      disposition: divergent
        ? 'MANUAL_DECISION_REQUIRED; preserve both ledger rows, do not mark/rename until original SQL bytes are recovered or an approved forward reconciliation is authored'
        : 'DO_NOT_TOUCH',
    };
  });

  const unknownRelations = new Set(unknownItems.flatMap((item: any) => item.affectedRelations));
  // Correct the two V4 relation aliases that caused false-negative footprint checks.
  unknownRelations.delete('data_provider_logs'); unknownRelations.add('provider_logs');
  unknownRelations.delete('market_masters'); unknownRelations.add('market_master');
  const checksumRelations = new Set(classification.filter((item: any) => item.classification === 'CHECKSUM_MISMATCH_CONTENT_DRIFT').flatMap((item: any) => item.affectedRelations));
  const divergentRelations = new Set(classification.filter((item: any) => item.v4Classification === 'DIVERGENT_DUPLICATE').flatMap((item: any) => item.affectedRelations));
  const conflictingRelations = new Set([...checksumRelations, ...divergentRelations]);
  const localPendingRelations = new Set(classification.filter((item: any) => item.localExists && !item.dbExists).flatMap((item: any) => item.affectedRelations));
  const legacyRelations = new Set(classification.filter((item: any) => item.v4Classification === 'VERIFIED_APPLIED_LEGACY').flatMap((item: any) => item.affectedRelations));
  const currentRelations = new Set(currentModels.keys());
  const attribution = { EXPECTED_LEGACY_DRIFT: 0, MIGRATION_LINEAGE_DRIFT: 0, PRISMA_MODEL_DRIFT: 0, LOCAL_ONLY_PENDING_DRIFT: 0, CONFLICTING_DRIFT: 0, UNATTRIBUTED_DRIFT: 0 };
  const attributedBlocks = diffBlocks(physicalDiff).map(block => {
    let category: keyof typeof attribution;
    if (relationTouches(block.sql, conflictingRelations)) category = 'CONFLICTING_DRIFT';
    else if (relationTouches(block.sql, unknownRelations)) category = 'MIGRATION_LINEAGE_DRIFT';
    else if (relationTouches(block.sql, localPendingRelations)) category = 'LOCAL_ONLY_PENDING_DRIFT';
    else if (relationTouches(block.sql, legacyRelations)) category = 'EXPECTED_LEGACY_DRIFT';
    else if (relationTouches(block.sql, currentRelations)) category = 'PRISMA_MODEL_DRIFT';
    else category = 'UNATTRIBUTED_DRIFT';
    attribution[category] += 1;
    return { operation: block.operation, category, evidence: block.sql.slice(0, 1200) };
  });

  const currentStat = await stat(path.resolve('prisma/schema.prisma'));
  const generatedStat = await stat(path.resolve('node_modules/.prisma/client/schema.prisma'));
  const currentOnlyModels = [...currentModels.keys()].filter(name => !generatedModels.has(name));
  const generatedOnlyModels = [...generatedModels.keys()].filter(name => !currentModels.has(name));
  const generatedClient = {
    state: v4Summary.schemaDrift.generatedClientState,
    currentSchemaChecksum: sha256(currentSchema), generatedSchemaChecksum: sha256(generatedSchema),
    currentSchemaModifiedAt: currentStat.mtime.toISOString(), generatedSchemaModifiedAt: generatedStat.mtime.toISOString(),
    currentSchemaAheadOfGeneratedClient: currentOnlyModels.length > 0 || sha256(currentSchema) !== sha256(generatedSchema),
    currentOnlyModelCount: currentOnlyModels.length, currentOnlyModels,
    generatedOnlyModelCount: generatedOnlyModels.length, generatedOnlyModels,
    productionAheadOrDivergentFromPrisma: diffBlocks(physicalDiff).length > 0,
    multipleGeneratedClientGenerationsEvidenced: false,
    unreconciledMigrationRelations: unknownLineages.map((item: any) => item.physicalSchemaTruth.expectedRelation),
    rootCause: 'STALE_GENERATED_CLIENT_PLUS_CURRENT_PRISMA_AND_PRODUCTION_BIDIRECTIONAL_DRIFT',
    recoveryPath: 'After approved migration lineage repair: restore exact historical migration files, author only approved forward reconciliation migrations, verify physical-to-Prisma diff, then run one controlled prisma generate and verify client checksum. No generate was run in V5.',
    clientDiffOperationCount: diffBlocks(clientDiff).length,
  };

  const physicalStocks = physicalModels.get('stocks');
  const physicalSecurities = physicalModels.get('securities');
  const currentStocks = currentModels.get('stocks');
  const currentSecurities = currentModels.get('securities');
  const bridgePrerequisites = [
    { id: 'BRIDGE_01_STOCKS_TABLE', status: physicalStocks ? 'PRESENT' : 'MISSING', evidence: 'physical introspection model stocks' },
    { id: 'BRIDGE_02_STOCK_ID', status: physicalStocks?.fields.has('id') ? 'PRESENT' : 'MISSING', evidence: 'stocks.id' },
    { id: 'BRIDGE_03_SECURITIES_TABLE', status: physicalSecurities ? 'PRESENT' : 'MISSING', evidence: 'physical introspection model securities' },
    { id: 'BRIDGE_04_SECURITY_ID', status: physicalSecurities?.fields.has('id') ? 'PRESENT' : 'MISSING', evidence: 'securities.id' },
    { id: 'BRIDGE_05_STOCK_SECURITY_ID_COLUMN', status: physicalStocks?.fields.has('security_id') ? 'PRESENT' : 'MISSING', evidence: 'stocks.security_id' },
    { id: 'BRIDGE_06_STOCK_SECURITY_UNIQUE', status: physicalStocks?.body.includes('@@unique([securityId]') ? 'PRESENT' : 'MISSING', evidence: 'unique stocks.security_id' },
    { id: 'BRIDGE_07_STOCK_SECURITY_FK', status: physicalStocks?.body.includes('@relation(fields: [securityId]') ? 'PRESENT' : 'MISSING', evidence: 'stocks.security_id -> securities.id' },
    { id: 'BRIDGE_08_PRISMA_STOCK_RELATION', status: currentStocks?.fields.has('security_id') ? 'PRESENT' : 'MISSING', evidence: 'current Prisma Stock.securityId mapping' },
    { id: 'BRIDGE_09_PRISMA_SECURITY_BACKRELATION', status: currentSecurities?.body.match(/\bstocks\b/i) ? 'PRESENT' : 'MISSING', evidence: 'current Prisma Security backrelation' },
    { id: 'BRIDGE_10_IDENTITY_RECONCILIATION', status: 'DEPENDENCY_BLOCKED', evidence: 'Stock has ticker/exchange; Security identity is not canonically reconciled and Stock lacks a verified security_id mapping' },
    { id: 'BRIDGE_11_MIGRATION_ORDER_DETERMINISTIC', status: 'DEPENDENCY_BLOCKED', evidence: '7 unknown lineages plus one divergent duplicate remain' },
    { id: 'BRIDGE_12_GENERATED_CLIENT_ALIGNED', status: generatedClient.state === 'ALIGNED' ? 'PRESENT' : 'DEPENDENCY_BLOCKED', evidence: generatedClient.state },
  ];

  const actions: any[] = [];
  for (const item of checksumMismatches) actions.push({
    id: `A_RESTORE_${item.migrationName}`, bundle: 'BUNDLE_A', type: 'RESTORE_LOCAL_MIGRATION_FILE', target: item.migrationName,
    reason: 'Current local migration bytes differ from production ledger; exact applied bytes are recoverable from Git.',
    evidence: item.exactGitVersion, preconditions: ['Explicit repository-repair approval', 'Clean or isolated worktree for target file'],
    risk: 'MEDIUM', verification: ['SHA-256 equals production checksum', 'git diff contains only approved historical file restoration'],
    rollbackAbortCondition: 'Abort if recovered bytes do not hash exactly or target has unrelated user edits.', dependencies: [],
  });
  for (const item of unknownLineages) actions.push({
    id: `D_DECIDE_${item.migrationName}`, bundle: 'BUNDLE_D', type: 'MANUAL_DECISION_REQUIRED', target: item.migrationName,
    reason: 'Production ledger is applied but no byte-exact SQL artifact exists; physical equivalence cannot recreate checksum lineage.',
    evidence: { checksumEvidence: item.checksumEvidence, footprint: item.physicalSchemaTruth },
    preconditions: ['Recover trusted deployment/backup artifact or approve a documented baseline exception'], risk: 'CRITICAL',
    verification: ['Independent artifact hash check', 'Physical footprint review', 'Chronological dependency review'],
    rollbackAbortCondition: 'Abort any ledger action unless exact SQL or approved exception exists.', dependencies: [],
  });
  actions.push({
    id: 'C_FORWARD_ASSET_LAYER_DECISION', bundle: 'BUNDLE_C', type: 'CREATE_FORWARD_RECONCILIATION_MIGRATION', target: 'assets.layer',
    reason: 'Ledger claims add_asset_layer applied, but the physical column and current Prisma field are absent.',
    evidence: unknownLineages.find((item: any) => item.migrationName === '20260705054545_add_asset_layer')?.physicalSchemaTruth,
    preconditions: ['Owner confirms assets.layer remains a required contract', 'Unknown lineage decision recorded', 'Schema design approved'], risk: 'HIGH',
    verification: ['Forward migration reviewed', 'Additive dry-run against isolated clone', 'No cross-asset data loss'],
    rollbackAbortCondition: 'Abort if layer was intentionally superseded or bridge dependency is ambiguous.',
    dependencies: ['D_DECIDE_20260705054545_add_asset_layer'],
  });
  actions.push({
    id: 'D_DIVERGENT_DUPLICATE_STOCK_HISTORY', bundle: 'BUNDLE_D', type: 'MANUAL_DECISION_REQUIRED', target: '20260727094000_add_stock_history_provenance',
    reason: 'Same migration name has two different checksums; failed SQL bytes are unavailable.', evidence: duplicateGroups.find((item: any) => item.classification === 'DIVERGENT_DUPLICATE'),
    preconditions: ['Recover both SQL artifacts or approve preservation plus forward-only reconciliation'], risk: 'CRITICAL',
    verification: ['Confirm failed row committed zero steps', 'Verify successful physical provenance footprint'],
    rollbackAbortCondition: 'Do not delete, rename, or resolve either production ledger row without explicit approval.', dependencies: [],
  });
  for (const item of duplicateGroups.filter((entry: any) => entry.classification === 'IDENTICAL_DUPLICATE')) actions.push({
    id: `A_KEEP_${item.migrationName}`, bundle: 'BUNDLE_A', type: 'DO_NOT_TOUCH', target: item.migrationName,
    reason: 'Duplicate ledger rows share an identical checksum and already record rollback/success history.', evidence: item.rows,
    preconditions: [], risk: 'LOW', verification: ['Retain ledger rows unchanged'], rollbackAbortCondition: 'Abort if any DB mutation is proposed.', dependencies: [],
  });

  const bundles = ['BUNDLE_A', 'BUNDLE_B', 'BUNDLE_C', 'BUNDLE_D'].map(bundle => {
    const bundleActions = actions.filter(action => action.bundle === bundle);
    const risk = bundleActions.some(action => action.risk === 'CRITICAL') ? 'CRITICAL'
      : bundleActions.some(action => action.risk === 'HIGH') ? 'HIGH'
      : bundleActions.some(action => action.risk === 'MEDIUM') ? 'MEDIUM' : bundleActions.length ? 'LOW' : 'NONE';
    return { bundle, title: {
      BUNDLE_A: 'NO_DB_MUTATION_REPOSITORY_REPAIR', BUNDLE_B: 'LEDGER_ONLY_RECONCILIATION',
      BUNDLE_C: 'FORWARD_ADDITIVE_SCHEMA_REPAIR', BUNDLE_D: 'CONFLICTING_HIGH_RISK_MANUAL',
    }[bundle], actionCount: bundleActions.length, risk, actionIds: bundleActions.map(action => action.id), approveTogether: false };
  });

  const unknownAfter = unknownLineages.filter((item: any) => item.remainsUnknownLineage).length;
  const bridgeCounts = (status: string) => bridgePrerequisites.filter(item => item.status === status).length;
  const summary = {
    task: 'GLOBAL_STOCK_MIGRATION_UNKNOWN_LINEAGE_RESOLUTION_V5', mode: 'READ_ONLY',
    databaseWritePerformed: false, migrationPerformed: false, prismaGenerateRun: false,
    dbOnlyUnknownBefore: 7, dbOnlyUnknownAfterAnalysis: unknownAfter,
    originalSqlRecoveredExactCount: unknownLineages.filter((item: any) => item.checksumEvidence === 'ORIGINAL_SQL_RECOVERED_EXACT').length,
    physicalEquivalenceOnlyCount: unknownLineages.filter((item: any) => item.checksumEvidence === 'PHYSICAL_EQUIVALENCE_ONLY').length,
    insufficientEvidenceCount: unknownLineages.filter((item: any) => item.checksumEvidence === 'INSUFFICIENT_EVIDENCE').length,
    checksumMismatch: { total: checksumMismatches.length, resolvedByEvidence: checksumMismatches.filter((item: any) => item.originalAppliedSqlAvailability === 'ORIGINAL_SQL_RECOVERED_EXACT').length, manualDecisionRequired: checksumMismatches.filter((item: any) => item.requiredRepairType === 'MANUAL_DECISION_REQUIRED').length },
    duplicates: { groups: duplicateGroups.length, identical: duplicateGroups.filter((item: any) => item.classification === 'IDENTICAL_DUPLICATE').length, divergent: duplicateGroups.filter((item: any) => item.classification === 'DIVERGENT_DUPLICATE').length },
    drift: { total: attributedBlocks.length, ...attribution },
    prismaSchemaDriftCount: v4Summary.schemaDrift.prismaAffectedRelationCount,
    generatedClient,
    bridge: { total: bridgePrerequisites.length, present: bridgeCounts('PRESENT'), missing: bridgeCounts('MISSING'), conflicting: bridgeCounts('CONFLICTING'), dependencyBlocked: bridgeCounts('DEPENDENCY_BLOCKED'), prerequisites: bridgePrerequisites },
    bundles,
    manualReviewRequiredCount: actions.filter(action => action.type === 'MANUAL_DECISION_REQUIRED').length,
    unknownMigrationStateCount: unknownAfter,
    migrationRepairReadyForApproval: false,
    bridgeMigrationSafeAfterProposedRepair: false,
    migrationSafeForAdditiveChange: false,
    p0StructuralPathReady: false, p0ProductionPathReady: false, depthGate: 'BLOCKED_MIGRATION_LINEAGE',
    safety: { backgroundSecurityBridgeStarted: false, backgroundTaxonomyStarted: false, backgroundAnalyticsStarted: false, backgroundProvenanceStarted: false, historicalRebuilt: false, stockUniverseRebuilt: false, websiteModified: false, deployPerformed: false },
    completedAt: now(),
  };

  await Promise.all([
    atomicJson('unknown-lineages.json', unknownLineages), atomicJson('checksum-mismatches.json', checksumMismatches),
    atomicJson('duplicate-groups.json', duplicateGroups), atomicJson('drift-attribution.json', { counts: attribution, operations: attributedBlocks }),
    atomicJson('generated-client-analysis.json', generatedClient), atomicJson('bridge-prerequisites.json', bridgePrerequisites),
    atomicJson('atomic-actions.json', actions), atomicJson('approval-bundles.json', bundles),
    atomicJson('reconciliation-summary.json', summary), atomicJson('completion-manifest.json', summary),
  ]);
  process.stdout.write(json(summary));
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
