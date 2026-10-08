// Regression test for the CLOUD_ETF_PRICE time-budget fix (2026-10-08). Confirmed in Production via
// the raw GitHub Actions log: every invocation timed out at exactly 300001ms with 0 bytes received —
// DEFAULT_BATCH=1000 with no time budget guaranteed the function never got anywhere near returning,
// so finishRun() never ran and every invocation was invisible in production_scheduler_runs.
//
// This route's per-item loop is tightly coupled to Prisma/live Yahoo calls (unlike
// cloud-moneydj-fund's extracted runMoneydjBatch), so this test checks the two things that matter
// without a live DB or network call: (1) the exported TIME_BUDGET_MS constant is sane — present,
// well under maxDuration — and (2) the source itself contains the three structural guarantees a
// time-budget fix requires, so a future edit can't silently regress one of them unnoticed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIME_BUDGET_MS } from '../../app/api/cron/cloud-etf-price/route';

function main() {
  assert.equal(typeof TIME_BUDGET_MS, 'number');
  assert.ok(TIME_BUDGET_MS > 0 && TIME_BUDGET_MS < 300_000, `TIME_BUDGET_MS (${TIME_BUDGET_MS}) must be a positive number safely under maxDuration=300000ms`);
  console.log(`TIME_BUDGET_MS_SANE: PASS (${TIME_BUDGET_MS}ms, ${300_000 - TIME_BUDGET_MS}ms margin under maxDuration)`);

  const src = readFileSync(new URL('../../app/api/cron/cloud-etf-price/route.ts', import.meta.url), 'utf8');

  // 1) The loop checks elapsed time and can break before exhausting the batch.
  assert.ok(/for \(const etf of candidates\) \{\s*\n\s*if \(Date\.now\(\) - startedMs > TIME_BUDGET_MS\) \{/.test(src), 'loop must check the time budget as its first statement each iteration');
  console.log('LOOP_CHECKS_TIME_BUDGET_FIRST: PASS');

  // 2) Checkpoint progress is saved via a finally block, so it fires on every exit path from the
  //    per-item try (both `continue`s and normal completion) — not just the happy path.
  assert.ok(/\} finally \{[\s\S]{0,200}await saveProgress\(lastId\);/.test(src), 'per-item checkpoint save must run in a finally block, not just after a successful upsert');
  console.log('CHECKPOINT_SAVED_IN_FINALLY: PASS');

  // 3) timeBudgetStop is wired into both reachedEnd (so a time-budget stop never wraps the cursor
  //    back to the start, unlike genuinely reaching the tail) and status (so it's visibly PARTIAL,
  //    not silently reported as a clean COMPLETED).
  assert.ok(src.includes('const reachedEnd = !timeBudgetStop && candidates.length < batch;'), 'reachedEnd must not be true on a time-budget stop');
  assert.ok(src.includes('const status = timeBudgetStop || (failed > 0 && inserted === 0) ? "PARTIAL" : "COMPLETED";'), 'status must be PARTIAL on a time-budget stop');
  console.log('TIME_BUDGET_STOP_WIRED_INTO_STATUS: PASS');
}

main();
console.log('ETF_PRICE_TIME_BUDGET_REGRESSION: PASS');
