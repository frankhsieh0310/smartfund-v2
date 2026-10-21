// 2026-10-21（14點任務第2項，使用者核准執行）: 把M&G「核准銷售」核心母體裡13檔完全沒有
// fund_share_classes記錄的share class補上去，正確分組成2個產品（M&G日本基金6級別、
// M&G 智慧收成基金7級別），沿用既有SMARTFUND_MASTER_MIGRATION_V1的欄位慣例
// （status='ACTIVE', source='SMARTFUND_MASTER_MIGRATION_V1', source_record_id=fund_id,
// currency直接複製funds.currency原樣、share_class_code留NULL不臆測）。
// 只動這13筆funds/新增對應的fund_share_classes，以及1筆新fund_master——不touch任何既有
// master、既有share class、NAV/holdings/任何其他資料表。
//
// Usage:
//   npx tsx scripts/data/funds/apply-mg-fund-master-grouping.ts            (dry-run，印出後ROLLBACK)
//   npx tsx scripts/data/funds/apply-mg-fund-master-grouping.ts --apply    (驗證通過才COMMIT)
import { Client } from "pg";

const JAPAN_FUND_EXISTING_MASTER_ID = "2dd2b5a4-81e2-5475-967e-25ad44855730";
const JAPAN_FUND_UNLINKED_IDS = [
  "456802f7-0d4a-4ece-abfb-59d5ecfbd4fe",
  "1db30437-80c6-4664-968f-1738926dad9d",
  "b212cbb8-f6ac-4479-86c7-de5355e29e99",
  "84054da3-b55f-48ca-a693-95bf5d7ddb68",
  "e7543c53-c76c-4065-bd94-6e160414f2c1",
];
const SMART_INCOME_FUND_IDS = [
  "fdf638b2-b1a1-4d74-8053-1520b43ed078",
  "5d2cab17-46c7-4a61-b528-2947e8214e4d",
  "a999cc6f-bba3-4410-b6d5-c45c7e388717",
  "6ea5d514-ef9a-438e-bbd1-67770934c772",
  "5df0934d-cced-4e50-bb24-d618ad021f8f",
  "3ae70e74-77fe-4dd4-bffc-5671cfe5e3fe",
  "e0c73870-0d6a-4412-a71b-138bd431c78f",
];
const EXPECTED_JAPAN_COUNT = 5;
const EXPECTED_SMART_INCOME_COUNT = 7;

async function main() {
  const apply = process.argv.includes("--apply");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");
  const client = new Client({ connectionString });
  await client.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params).then((r) => r.rows);

  let committed = false;
  try {
    await query("BEGIN");

    // --- Guard: all 12 target fund rows must still exist, have no fund_share_classes row, and be
    //     in the approved-for-sale core universe (unchanged since the dry-run). ---
    const allTargetIds = [...JAPAN_FUND_UNLINKED_IDS, ...SMART_INCOME_FUND_IDS];
    const current = await query(
      `SELECT f.id, f.name, f.currency, f.code,
              EXISTS(SELECT 1 FROM fund_share_classes WHERE fund_id = f.id) AS already_linked,
              f.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='FUND' AND status='APPROVED') AS in_core_universe
       FROM funds f WHERE f.id = ANY($1::text[])`,
      [allTargetIds],
    );
    if (current.length !== allTargetIds.length) {
      console.error(`MIGRATION_GUARD: ABORT — expected ${allTargetIds.length} funds, found ${current.length}.`);
      await query("ROLLBACK");
      process.exitCode = 1;
      return;
    }
    const alreadyLinked = current.filter((r) => r.already_linked);
    const notInCoreUniverse = current.filter((r) => !r.in_core_universe);
    if (alreadyLinked.length || notInCoreUniverse.length) {
      console.error("MIGRATION_GUARD: ABORT — state changed since dry-run.", { alreadyLinked, notInCoreUniverse });
      await query("ROLLBACK");
      process.exitCode = 1;
      return;
    }
    console.log(`MIGRATION_GUARD: PASS — all ${current.length} target funds unlinked and still in core universe.`);

    const byId = new Map(current.map((r) => [r.id, r]));

    // --- Step 1: M&G日本基金 — link the 5 unlinked classes onto the EXISTING singleton master. ---
    const existingMaster = await query(`SELECT id, representative_fund_id FROM public.fund_master WHERE id = $1`, [JAPAN_FUND_EXISTING_MASTER_ID]);
    if (existingMaster.length !== 1) {
      console.error("MIGRATION_GUARD: ABORT — M&G日本基金 existing master not found.");
      await query("ROLLBACK");
      process.exitCode = 1;
      return;
    }
    let japanInserted = 0;
    for (const fundId of JAPAN_FUND_UNLINKED_IDS) {
      const f = byId.get(fundId)!;
      await query(
        `INSERT INTO fund_share_classes (id, fund_id, share_class_name, currency, status, source, source_record_id, master_fund_id, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'ACTIVE', 'SMARTFUND_MASTER_MIGRATION_V1', $1, $4, NOW(), NOW())`,
        [fundId, f.name, f.currency, JAPAN_FUND_EXISTING_MASTER_ID],
      );
      japanInserted++;
    }

    // --- Step 2: M&G 智慧收成基金 — new master; representative = lowest fund_id (no holdings signal
    //     available to break ties for this non-Yahoo provider, same fallback rule as the existing
    //     migrate-fund-master-grouping.ts script uses). ---
    const smartIncomeRepresentative = [...SMART_INCOME_FUND_IDS].sort()[0];
    const newMaster = await query(
      `INSERT INTO public.fund_master (id, canonical_name, base_currency, provider_master_key, representative_fund_id, created_at, updated_at)
       VALUES (gen_random_uuid()::text, 'M&G 智慧收成基金', $1, $2, $3, NOW(), NOW())
       RETURNING id`,
      [byId.get(smartIncomeRepresentative)!.currency, `TDCC_OFFSHORE:M&G 智慧收成基金`, smartIncomeRepresentative],
    );
    const newMasterId = newMaster[0].id;
    let smartIncomeInserted = 0;
    for (const fundId of SMART_INCOME_FUND_IDS) {
      const f = byId.get(fundId)!;
      await query(
        `INSERT INTO fund_share_classes (id, fund_id, share_class_name, currency, status, source, source_record_id, master_fund_id, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'ACTIVE', 'SMARTFUND_MASTER_MIGRATION_V1', $1, $4, NOW(), NOW())`,
        [fundId, f.name, f.currency, newMasterId],
      );
      smartIncomeInserted++;
    }

    // --- Verify ---
    const japanMemberCount = (await query(`SELECT count(*)::int AS n FROM fund_share_classes WHERE master_fund_id = $1`, [JAPAN_FUND_EXISTING_MASTER_ID]))[0].n;
    const smartIncomeMemberCount = (await query(`SELECT count(*)::int AS n FROM fund_share_classes WHERE master_fund_id = $1`, [newMasterId]))[0].n;
    const japanOk = japanInserted === EXPECTED_JAPAN_COUNT && japanMemberCount === EXPECTED_JAPAN_COUNT + 1; // +1 for the pre-existing member
    const smartIncomeOk = smartIncomeInserted === EXPECTED_SMART_INCOME_COUNT && smartIncomeMemberCount === EXPECTED_SMART_INCOME_COUNT;

    console.log("\nVERIFICATION:");
    console.log(`  M&G日本基金: inserted ${japanInserted} (expected ${EXPECTED_JAPAN_COUNT}), master now has ${japanMemberCount} members (expected ${EXPECTED_JAPAN_COUNT + 1}) ->`, japanOk ? "PASS" : "FAIL");
    console.log(`  M&G 智慧收成基金: inserted ${smartIncomeInserted} (expected ${EXPECTED_SMART_INCOME_COUNT}), new master ${newMasterId} has ${smartIncomeMemberCount} members ->`, smartIncomeOk ? "PASS" : "FAIL");

    if (!japanOk || !smartIncomeOk) {
      console.error("\nVERIFICATION FAILED — rolling back.");
      await query("ROLLBACK");
      process.exitCode = 1;
      return;
    }

    if (!apply) {
      console.log("\nDRY_RUN: all steps executed and verified inside this transaction, then rolling back. No data was written. Re-run with --apply to commit.");
      await query("ROLLBACK");
      return;
    }

    await query("COMMIT");
    committed = true;
    console.log("\nCOMMIT: M&G fund-master grouping backfill applied.");
  } catch (e) {
    try { await query("ROLLBACK"); } catch { /* connection may already be unusable */ }
    throw e;
  } finally {
    await client.end();
    if (!committed) console.log("\n(transaction was rolled back; Production is unchanged)");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
