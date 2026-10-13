// Regression test for the CLOUD_MONEYDJ_FUND time-budget + incremental-checkpoint fix
// (app/api/cron/cloud-moneydj-fund/route.ts). Confirmed in Production: before this fix, every run
// was stuck IN_PROGRESS with attempted=0 forever, because progress was only ever written once, at
// the very end of the loop — if the run was killed before reaching the end (as it always was),
// nothing was saved and the next run re-started from the exact same place.
//
// This test drives the extracted runMoneydjBatch() loop directly (no DB, no network): a fake clock
// that reports elapsed time past the budget partway through the batch, and an instant fake
// processOne. It asserts (1) onProgress — the stand-in for the real per-item checkpoint write —
// fires after every item actually reached, not just once at the end; (2) the loop stops exactly
// when the time budget is exceeded, not when the batch is exhausted; (3) lastId / the final
// onProgress call point at the correct resume position; (4) a second simulated invocation, resuming
// from that position with a fresh (reset) budget, completes the remaining items and never
// re-processes ones already done in the first call — proving the checkpoint-driven resume contract.
import assert from 'node:assert/strict';
import { runMoneydjBatch } from '../../app/api/cron/cloud-moneydj-fund/route';

type Fund = { fundId: string; moneydjCode: string; canonicalName: string; portfolioKey: string };

function makeFunds(n: number): Fund[] {
  // Standalone funds (no master mapping): portfolioKey === fundId, same as nextCodes() falls back
  // to COALESCE(sc.master_fund_id, f.id) when there's no verified master.
  return Array.from({ length: n }, (_, i) => {
    const fundId = `fund-${String(i).padStart(3, '0')}`;
    return { fundId, moneydjCode: `MDJ${i}`, canonicalName: `Fund ${i}`, portfolioKey: fundId };
  });
}

async function main() {
  const codes = makeFunds(10);

  // --- Call 1: budget runs out after the 4th item is reached. ---
  let clock = 0;
  const progressCalls: Array<{ lastId: string; attempted: number }> = [];
  const processed: string[] = [];
  const outcome1 = await runMoneydjBatch(codes, {
    cursor: '',
    startedMs: 0,
    timeBudgetMs: 1000,
    now: () => clock,
    sleep: async () => {},
    processOne: async (fund) => {
      processed.push(fund.fundId);
      clock += 300; // each item "takes" 300ms of simulated time
      return { rowsPersisted: 3, isNewMonth: true };
    },
    onProgress: async (lastId, counters) => {
      progressCalls.push({ lastId, attempted: counters.attempted });
    },
  });

  assert.equal(outcome1.timeBudgetStop, true, 'must stop because of the time budget, not run out of items');
  assert.equal(outcome1.backoffStop, false);
  // clock crosses 1000ms partway through item 4 (300*4=1200 > 1000), so 4 items get processed before the budget check trips on the 5th.
  assert.equal(processed.length, 4, `expected exactly 4 items processed before the budget tripped, got ${processed.length}`);
  assert.equal(outcome1.attempted, 4);
  assert.equal(outcome1.lastId, 'fund-003');
  console.log('TIME_BUDGET_STOPS_LOOP: PASS (processed', processed.length, 'of', codes.length, ')');

  // The critical assertion: progress was saved after EVERY item reached, not just once at the end.
  assert.equal(progressCalls.length, 4, 'onProgress must fire once per item reached, not once for the whole batch');
  assert.deepEqual(
    progressCalls.map((c) => c.lastId),
    ['fund-000', 'fund-001', 'fund-002', 'fund-003'],
  );
  assert.deepEqual(
    progressCalls.map((c) => c.attempted),
    [1, 2, 3, 4],
  );
  console.log('PER_ITEM_CHECKPOINT_WRITTEN: PASS (' + progressCalls.length + ' incremental writes)');

  // --- Call 2: simulates the NEXT cron invocation, resuming from the checkpoint call 1 left behind
  //     (fund-003), with its own fresh time budget. It must only see funds AFTER the cursor (this
  //     mirrors nextCodes()'s `f.id > $1` in the real route) and must complete the rest. ---
  const resumeCursor = progressCalls.at(-1)!.lastId; // what the next run's readCheckpoint() would return
  const remaining = codes.filter((f) => f.fundId > resumeCursor);
  assert.equal(remaining.length, 6, 'the next invocation must see exactly the unprocessed tail');

  clock = 0;
  const processed2: string[] = [];
  const outcome2 = await runMoneydjBatch(remaining, {
    cursor: resumeCursor,
    startedMs: 0,
    timeBudgetMs: 10_000, // ample budget this time
    now: () => clock,
    sleep: async () => {},
    processOne: async (fund) => {
      processed2.push(fund.fundId);
      clock += 300;
      return { rowsPersisted: 2, isNewMonth: true };
    },
    onProgress: async () => {},
  });

  assert.equal(outcome2.timeBudgetStop, false);
  assert.equal(outcome2.attempted, 6);
  assert.equal(outcome2.lastId, 'fund-009');
  // No overlap with what call 1 already processed.
  assert.equal(processed2.some((id) => processed.includes(id)), false, 'resume must never re-process an item already done in call 1');
  console.log('RESUME_COMPLETES_REMAINDER_NO_DUPLICATE: PASS (processed', processed2.length, 'more, no overlap)');

  // --- Backoff path: still writes progress before stopping, same as the time-budget path. ---
  const backoffProgress: string[] = [];
  const { MoneydjHttpError } = await import('../../lib/cloud-ingestion/moneydjFundDisclosure');
  const outcome3 = await runMoneydjBatch(makeFunds(3), {
    cursor: '',
    startedMs: 0,
    timeBudgetMs: 999_999,
    now: () => 0,
    sleep: async () => {},
    processOne: async (fund) => {
      if (fund.fundId === 'fund-001') throw new MoneydjHttpError(429, null);
      return { rowsPersisted: 1, isNewMonth: true };
    },
    onProgress: async (lastId) => {
      backoffProgress.push(lastId);
    },
  });
  assert.equal(outcome3.backoffStop, true);
  assert.equal(outcome3.http429, 1);
  assert.deepEqual(backoffProgress, ['fund-000', 'fund-001'], 'progress through the failing item must still be saved before the backoff stop');
  console.log('BACKOFF_STOP_STILL_SAVES_PROGRESS: PASS');
}

main()
  .then(() => console.log('MONEYDJ_FUND_BATCH_REGRESSION: PASS'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
