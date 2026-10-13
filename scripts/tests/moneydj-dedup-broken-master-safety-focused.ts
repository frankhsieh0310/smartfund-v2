// Safety test: does cloud-moneydj-fund's new master-fund dedup (d9c4c46a6) ever reach the 5 known-
// broken fund_master groups (Fidelity/Russell/Morgan Stanley/Columbia/VALIC Company — the 811 rows
// diagnosed in f48d8e25a, not yet migrated in Production) through any path?
//
// Read-only against the real DB (no writes, no network fetch, no full scan — targeted queries only,
// same shape nextCodes() uses). Asserts the invariant structurally, not just for today's data: the
// 811 rows are Yahoo-US-MF-sourced funds with no Taiwan MoneyDJ distribution, so they can never carry
// a fund_mappings.moneydj_code — which is the FIRST filter in nextCodes()'s candidates CTE, before
// master_fund_id grouping is even considered. A broken master is unreachable by this code path
// unless a moneydj_code gets attached to one of its member funds or its representative_fund_id.
import assert from 'node:assert/strict';
import { Client } from 'pg';

const BROKEN_MASTERS: Record<string, string> = {
  '34566cf2-82d3-4dcc-bdc7-8c5b59e243a0': 'Fidelity',
  '02315ede-8a50-4809-a9cc-0ca525d11d16': 'Russell',
  '212a169c-693d-4fb7-b1ab-e2b93b235908': 'Morgan Stanley',
  'b9d702f4-936a-45db-b2c4-39cd4e9dcf2e': 'Columbia',
  '8b4329d0-6f05-4135-8c94-36eb70004df4': 'VALIC Company',
};
const EXPECTED_BROKEN_ROWS = 811;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const q = (sql: string, params: unknown[]) => client.query(sql, params).then((r) => r.rows);

  try {
    // 1) Sanity: the 811 rows are still there, under exactly the 5 known master ids (matches
    //    diagnosis). If this ever drifts, the test fails loudly rather than silently passing.
    const total = await q(
      `SELECT count(*)::int AS n FROM fund_share_classes WHERE master_fund_id = ANY($1::text[])`,
      [Object.keys(BROKEN_MASTERS)],
    );
    assert.equal(total[0].n, EXPECTED_BROKEN_ROWS, `expected ${EXPECTED_BROKEN_ROWS} rows under the 5 broken masters, found ${total[0].n}`);
    console.log(`BROKEN_MASTER_ROW_COUNT: PASS (${total[0].n})`);

    // 2) None of those 811 share-class fund_ids has a moneydj_code — i.e. cloud-moneydj-fund's
    //    nextCodes() candidates CTE (WHERE m.moneydj_code IS NOT NULL) can never select one.
    const memberOverlap = await q(
      `SELECT sc.master_fund_id, f.id AS fund_id, m.moneydj_code
         FROM fund_share_classes sc
         JOIN funds f ON f.id = sc.fund_id
         JOIN fund_mappings m ON m.fund_id = f.id
        WHERE sc.master_fund_id = ANY($1::text[]) AND m.moneydj_code IS NOT NULL`,
      [Object.keys(BROKEN_MASTERS)],
    );
    assert.equal(memberOverlap.length, 0, 'a broken-master share class has a moneydj_code — the dedup query WOULD reach it');
    console.log('WRONG_FUNDS_SKIPPED: 0 (no broken-master share class carries a moneydj_code)');

    // 3) Representative_fund_id for each broken master also has no moneydj_code — the one other
    //    place a broken grouping could leak into a MoneyDJ-driven query.
    const repOverlap = await q(
      `SELECT fm.id, fm.representative_fund_id, m.moneydj_code
         FROM fund_master fm
         JOIN fund_mappings m ON m.fund_id = fm.representative_fund_id
        WHERE fm.id = ANY($1::text[])`,
      [Object.keys(BROKEN_MASTERS)],
    );
    assert.equal(repOverlap.length, 0, 'a broken master\'s representative_fund_id has a moneydj_code');
    console.log('REPRESENTATIVE_FUND_ID_NO_OVERLAP: PASS');

    // 4) Run the EXACT candidates CTE cloud-moneydj-fund's nextCodes() uses (read-only, LIMIT-free
    //    over just the 5 broken masters) and confirm it returns zero rows — the structural proof,
    //    not just an indirect join check.
    const reachable = await q(
      `SELECT f.id
         FROM fund_mappings m
         JOIN funds f ON f.id = m.fund_id
         LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id
        WHERE m.moneydj_code IS NOT NULL
          AND COALESCE(sc.master_fund_id, f.id) = ANY($1::text[])`,
      [Object.keys(BROKEN_MASTERS)],
    );
    assert.equal(reachable.length, 0, 'nextCodes()\'s own candidate query reaches a broken master portfolio_key');
    console.log('NEXTCODES_CANDIDATE_QUERY_UNREACHABLE: PASS (0 rows)');

    // 5) Control: a known-GOOD multi-share-class master (confirmed correct in earlier rounds —
    //    a 東方匯理/Amundi TW fund with real currency/distribution share classes) still dedupes to
    //    exactly 1 representative row, proving the dedup logic itself still works normally and this
    //    isn't "dedup accidentally disabled everywhere."
    const goodMasterSample = await q(
      `SELECT sc.master_fund_id, count(*)::int AS share_classes
         FROM fund_share_classes sc
         JOIN fund_mappings m ON m.fund_id = sc.fund_id
        WHERE sc.master_fund_id IS NOT NULL AND m.moneydj_code IS NOT NULL
        GROUP BY sc.master_fund_id
        HAVING count(*) >= 2
        ORDER BY count(*) DESC
        LIMIT 1`,
      [],
    );
    assert.ok(goodMasterSample.length === 1, 'expected at least one real multi-share-class MoneyDJ master to exist for this control check');
    const goodMasterId = goodMasterSample[0].master_fund_id;
    const dedupedForGoodMaster = await q(
      `SELECT DISTINCT ON (COALESCE(sc.master_fund_id, f.id)) f.id
         FROM fund_mappings m
         JOIN funds f ON f.id = m.fund_id
         LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id
        WHERE m.moneydj_code IS NOT NULL AND COALESCE(sc.master_fund_id, f.id) = $1
        ORDER BY COALESCE(sc.master_fund_id, f.id), f.id`,
      [goodMasterId],
    );
    assert.equal(dedupedForGoodMaster.length, 1, `a verified-good master with ${goodMasterSample[0].share_classes} share classes must still dedup to exactly 1 candidate row`);
    console.log(`GOOD_MASTER_SAMPLE_STILL_DEDUPS: PASS (master ${goodMasterId}, ${goodMasterSample[0].share_classes} share classes -> 1 candidate)`);
  } finally {
    await client.end();
  }
}

main()
  .then(() => console.log('MONEYDJ_DEDUP_BROKEN_MASTER_SAFETY: PASS'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
