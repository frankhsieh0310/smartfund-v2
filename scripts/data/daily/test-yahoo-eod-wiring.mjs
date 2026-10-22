import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the actual runner functions without importing its executable entry point.
// All DB/provider dependencies below are test doubles; no production writes occur.
const source = readFileSync(new URL('./run-production-yahoo-daily.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('daily.ts', source, ts.ScriptTarget.Latest, true);
const code = name => tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree);
const compile = (names, bindings = {}) => new Function(...Object.keys(bindings), ts.transpile(names.map(code).join('\n')) + `;return {${names.join(',')}}`)(...Object.values(bindings));
const { sourceAction, validDailyCandle } = compile(['sourceAction', 'validDailyCandle']);
assert.equal(sourceAction('2020-01-02', '2020-01-02', false, false), 'NOOP');
assert.equal(sourceAction('2020-01-03', '2020-01-02', false, false), 'PRIMARY');
assert.equal(sourceAction('2020-01-03', null, true, true), 'RETRY');
assert.equal(sourceAction('2020-01-03', null, true, false), 'NOOP');
assert.equal(validDailyCandle({ open: 1, high: 2, low: 1, close: 2, volume: 0, adjClose: null }), true);
assert.equal(validDailyCandle({ open: 1, high: 2, low: 1, close: 2, volume: null, adjClose: 2 }), false);

let fetches = 0;
const db = {
  stockHistory: { findUnique: async () => ({ id: 'fixture', source: 'YAHOO', sourceSymbol: 'TEST', open: 1, high: 2, low: 1, close: 2, volume: 0 }) },
  stock: { updateMany: async () => ({ count: 1 }), findMany: async options => { assert.deepEqual(options.where.id.in, ['failed-id']); return []; } },
  $executeRawUnsafe: async () => 1,
  $queryRawUnsafe: async sql => { assert.match(sql, /resolved=FALSE.*classification='RETRYABLE_FAILURE'/); return [{ stock_id: 'failed-id' }]; },
};
const { processStock, stockTasks } = compile(['validDailyCandle', 'processStock', 'stockTasks'], {
  prisma: db, utcDate: value => new Date(value), fetchYahooChart: async () => { fetches++; throw Error('Already current must not fetch'); },
});
const result = await processStock({ id: 'test' }, { id: 'test', yahooSymbol: 'TEST' }, '2020-01-02', '2020-01-02');
assert.equal(fetches, 0);
assert.equal(result.noUpdate, 1);
// Repair revalidates complete-but-outdated Yahoo rows through the same writer.
let repairWrites = 0;
const repairDb = {
  ...db,
  stockHistory: { ...db.stockHistory, upsert: async () => { repairWrites++; } },
  stock: { ...db.stock, update: async () => ({}) },
};
const repairRunner = compile(['validDailyCandle', 'processStock'], {
  prisma: repairDb, utcDate: value => new Date(value), addCalendarDays: value => value,
  validateProviderMetadata: () => {}, candleKey: () => '2020-01-02',
  fetchYahooChart: async () => ({ candles: [{ open: 1, high: 2, low: 1, close: 2, volume: 0, adjClose: null }] }),
});
const repaired = await repairRunner.processStock({ id: 'test' }, { id: 'test', yahooSymbol: 'TEST', latestDate: null }, '2020-01-02', '2020-01-02', true);
assert.equal(repairWrites, 1);
assert.equal(repaired.success, 1);
assert.equal(repaired.noUpdate, 0);
await stockTasks({ id: 'test', exchanges: ['TEST'], country: 'TEST' }, 'RETRY', '2020-01-02');

const { queueIncompleteEod } = compile(['queueIncompleteEod'], { prisma: {
  $executeRawUnsafe: async (sql, ...args) => {
    assert.deepEqual(args, ['test', ['TEST'], 'TEST', '2020-01-02']);
    assert.match(sql, /AND NOT COALESCE\(h\.open>0/);
    const update = sql.split('DO UPDATE SET')[1];
    assert.match(update, /classification='RETRYABLE_FAILURE'/);
    assert.doesNotMatch(update, /attempts\s*=/);
    assert.doesNotMatch(update, /first_failed_at\s*=/);
    return 1;
  },
} });
await queueIncompleteEod({ id: 'test', exchanges: ['TEST'], country: 'TEST' }, '2020-01-02');

const checkpoint = { last_symbol: 'B', processed: 2, succeeded: 2, failed: 0, details: null };
const { loadResume } = compile(['loadResume'], {
  prisma: db, utcDate: value => new Date(value),
  loadLifecycleResumeCheckpoint: async (_db, job, context) => {
    assert.equal(job, 'test'); assert.equal(context.runType, 'PRIMARY');
    assert.equal(context.targetTradeDate.toISOString().slice(0, 10), '2020-01-02');
    return checkpoint;
  },
});
assert.equal(await loadResume({ id: 'test' }, '2020-01-02', 'PRIMARY'), checkpoint);
const execute = code('execute');
assert.match(execute, /all\.slice\(resumeIndex \+ 1\)/);
assert.match(execute, /persistLifecycleCheckpoint/);
const dispatcher = code('dispatcher').slice(code('dispatcher').indexOf('const staleCleanup'));
assert.equal((dispatcher.match(/await providerReady\(/g) ?? []).length, 1);
assert.ok(dispatcher.indexOf('if (planOnly)') < dispatcher.indexOf('await providerReady'));
assert.ok(dispatcher.indexOf('dueAt > now') < dispatcher.indexOf('await providerReady'));
const sort = dispatcher.match(/decisions\.sort\(\(a, b\) => \{([\s\S]*?)\n  \}\);/)[1];
const compare = new Function('a', 'b', ts.transpile(`function compare(a: any,b: any){${sort}}`) + ';return compare(a,b)');
const decisions = [{ runType: 'RETRY', dueAt: new Date(0) }, { runType: 'PRIMARY', dueAt: new Date(2) }, { runType: 'PRIMARY', dueAt: new Date(1) }];
assert.deepEqual(decisions.sort(compare).map(row => +row.dueAt), [1, 2, 0]);
assert.match(source, /adjustedClose: adjustedClose \?\? undefined/);
console.log('SOURCE_UNCHANGED_NOOP: PASS\nSOURCE_NEWER_UPDATE: PASS\nFAILED_SUBSET_REPAIR: PASS\nCHECKPOINT_RESUME: PASS\nSUCCESSFUL_EOD_NOT_REFETCHED: PASS\nNULLABLE_ADJUSTED: PASS\nPROBE_AND_ORDER: PASS\nPRODUCTION_WRITES: 0');
