// Regression test for the Decimal(8,4) overflow guard in app/api/cron/cloud-etf-price/route.ts.
// etf_performance.return_* columns are Decimal(8,4), max magnitude 9999.9999. Confirmed in
// Production (PostgresError 22003 "numeric field overflow" on KSM-F112.TA, 2026-10-03): a
// near-zero base price can produce a computed percentage the column can't store, which previously
// threw and aborted the whole upsert — including the subsequent etf.update that advances
// priceUpdatedAt, leaving that symbol permanently re-tried and permanently failing.
import assert from 'node:assert/strict';
import { periodReturn } from '../../app/api/cron/cloud-etf-price/route';

function main() {
  const day = 86_400_000;
  const d = (daysAgo: number) => new Date(Date.UTC(2026, 9, 7) - daysAgo * day);

  // Normal case: unaffected, exact value preserved (not truncated/adjusted).
  const normal = [{ date: d(365), price: 100 }, { date: d(0), price: 112.5 }];
  assert.equal(periodReturn(normal, 365), 12.5);
  console.log('NORMAL_RETURN_UNCHANGED: PASS');

  // Overflow case: near-zero base price -> astronomically large % -> must come back null, not throw.
  const overflow = [{ date: d(365), price: 0.0000001 }, { date: d(0), price: 5 }];
  const overflowResult = periodReturn(overflow, 365);
  assert.equal(overflowResult, null);
  console.log('OVERFLOW_RETURNS_NULL: PASS');

  // Boundary: just inside the Decimal(8,4) max must still be stored as a real number.
  const atLimit = [{ date: d(365), price: 1 }, { date: d(0), price: 100.999999 }];
  const atLimitResult = periodReturn(atLimit, 365);
  assert.ok(atLimitResult !== null && Math.abs(atLimitResult) <= 9999.9999);
  console.log('WITHIN_LIMIT_PRESERVED: PASS (value=' + atLimitResult + ')');

  // Boundary: just outside must be null, not silently clamped/truncated to the max.
  const overLimit = [{ date: d(365), price: 1 }, { date: d(0), price: 101.01 }];
  const overLimitResult = periodReturn(overLimit, 365);
  assert.equal(overLimitResult, null, 'a value just over the column limit must be null, never clamped to the boundary');
  console.log('OVER_LIMIT_NOT_CLAMPED_TO_BOUNDARY: PASS');

  // No base point in range -> unchanged behavior (null, not an error).
  assert.equal(periodReturn([{ date: d(0), price: 100 }], 365), null);
  console.log('NO_BASE_POINT_NULL: PASS (unchanged pre-existing behavior)');
}

main();
console.log('ETF_PRICE_OVERFLOW_REGRESSION: PASS');
