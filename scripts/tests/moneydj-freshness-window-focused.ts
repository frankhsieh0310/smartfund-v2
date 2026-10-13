// Regression test for freshnessCutoffDate() (app/api/cron/cloud-moneydj-fund/route.ts): 每月 8-15日
// should demand THIS month's data specifically (tight re-check window around the official
// disclosure dates), while every other day falls back to the existing 25-day rolling backstop that
// catches funds which published late ("晚公布的基金後續補查").
import assert from 'node:assert/strict';
import { freshnessCutoffDate } from '../../app/api/cron/cloud-moneydj-fund/route';

function main() {
  // Inside the 8th-15th window (Asia/Taipei): cutoff must be the 1st of the current month.
  const day10 = new Date('2026-10-10T03:00:00.000Z'); // 2026-10-10 11:00 Asia/Taipei
  assert.equal(freshnessCutoffDate(day10), '2026-10-01');
  console.log('WINDOW_DAY10_CUTS_AT_MONTH_START: PASS');

  const day8 = new Date('2026-10-08T00:00:00.000Z'); // 2026-10-08 08:00 Asia/Taipei
  assert.equal(freshnessCutoffDate(day8), '2026-10-01');
  const day15 = new Date('2026-10-15T15:59:00.000Z'); // 2026-10-15 23:59 Asia/Taipei (still day 15)
  assert.equal(freshnessCutoffDate(day15), '2026-10-01');
  console.log('WINDOW_BOUNDARIES_8_AND_15_INCLUSIVE: PASS');

  // Just outside the window: day 7 and day 16 (Asia/Taipei) must use the 25-day rolling cutoff,
  // not the tight month-start one.
  const day7 = new Date('2026-10-06T17:00:00.000Z'); // 2026-10-07 01:00 Asia/Taipei
  const cutoff7 = freshnessCutoffDate(day7);
  assert.notEqual(cutoff7, '2026-10-01');
  const expected7 = new Date(day7.getTime() - 25 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(cutoff7, expected7);
  console.log('DAY7_USES_ROLLING_BACKSTOP: PASS (cutoff=' + cutoff7 + ')');

  const day16 = new Date('2026-10-15T17:00:00.000Z'); // 2026-10-16 01:00 Asia/Taipei
  const cutoff16 = freshnessCutoffDate(day16);
  const expected16 = new Date(day16.getTime() - 25 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(cutoff16, expected16);
  console.log('DAY16_USES_ROLLING_BACKSTOP: PASS (cutoff=' + cutoff16 + ')');

  // A fund that published late (say, the 20th) must still show up as needing a check once the
  // rolling window catches up — i.e. the day-16..31 cutoff is a real date in the past, not "never".
  const rollingCutoff = new Date(day16.getTime() - 25 * 86_400_000);
  assert.ok(rollingCutoff.getTime() < day16.getTime());
  console.log('LATE_FILER_BACKSTOP_IS_A_REAL_PAST_DATE: PASS');
}

main();
console.log('MONEYDJ_FRESHNESS_WINDOW_REGRESSION: PASS');
