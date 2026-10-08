// Focused test for the cloud-data-ingestion.yml concurrency fix (2026-10-08). Confirmed root cause:
// every one of the ~29 distinct schedule triggers in this file shared ONE concurrency group
// ("cloud-data-ingestion"), so with cancel-in-progress:false, an unrelated job's run (commodity,
// index, consensus, etc.) occupying the single pending slot could silently cancel the ETF-price
// trigger before it ever started — indistinguishable in the run history from "didn't fire at all".
//
// This only validates the YAML structurally (no live GitHub Actions dispatch to test against):
// (1) every schedule cron entry is byte-identical to before the fix — no other job's trigger time
//     changed; (2) the concurrency group is now keyed per-trigger (via github.event.schedule), not
//     a single shared literal; (3) cancel-in-progress is unchanged (still false — this fix is about
//     isolation, not about allowing a run to kill its own predecessor).
import assert from 'node:assert/strict';
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';

const EXPECTED_SCHEDULE_CRONS = [
  '7 * * * *', '17 * * * *', '27 * * * *', '37 * * * *', '47 * * * *', '57 * * * *',
  '30 8 * * 1-5', '0 */3 * * *', '30 10 * * 1-5', '30 14 * * 1-5', '0 13 * * *', '30 11 * * 1-5',
  '0 */2 * * 1-5', '39 0 * * *', '23 0 * * *', '26 0 * * *',
  '40 19 * * 1-5', '0 20 * * 1-5', '20 20 * * 1-5', '0 21 * * 1-5',
  '20 6 * * 1-5', '45 6 * * 1-5', '20 7 * * 1-5', '45 7 * * 1-5', '25 8 * * 1-5',
  '15 9 * * 1-5', '15 10 * * 1-5', '5 16 * * 1-5', '50 16 * * 1-5', '15 21 * * 1-5',
];

function main() {
  const doc = load(readFileSync('.github/workflows/cloud-data-ingestion.yml', 'utf8')) as any;

  const actualCrons = (doc.on.schedule as Array<{ cron: string }>).map((s) => s.cron);
  assert.deepEqual(actualCrons, EXPECTED_SCHEDULE_CRONS, 'schedule triggers must be byte-identical — this fix touches only concurrency, no job\'s cron time');
  console.log(`SCHEDULE_UNCHANGED: PASS (${actualCrons.length} triggers, all preserved)`);

  const group: string = doc.concurrency.group;
  assert.ok(group.includes('github.event.schedule'), 'concurrency group must be keyed per trigger via github.event.schedule, not a fixed literal');
  assert.notEqual(group, 'cloud-data-ingestion', 'must not still be the old single shared literal group');
  console.log('CONCURRENCY_KEYED_PER_TRIGGER: PASS (group=' + group + ')');

  assert.equal(doc.concurrency['cancel-in-progress'], false, 'cancel-in-progress must remain false — only isolation changed, not whether a run can kill its own in-flight predecessor');
  console.log('CANCEL_IN_PROGRESS_UNCHANGED: PASS');
}

main();
console.log('CLOUD_INGESTION_CONCURRENCY_REGRESSION: PASS');
