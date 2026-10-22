// 2026-10-22（使用者核准，刪除範圍外基金資料前的必要前置步驟）: 已於當天對Production執行過，
// 保留在版控作為執行記錄（同run-scheduled-update.mjs等其他一次性migration腳本的慣例）。不要
// 重複執行——precheck會在old_rep已經不是現在值時直接丟錯，是故意設計成不可重複跑第二次。
import { config } from "dotenv";
config({ path: ".env" });
import { Client } from "pg";

// 17組的新代表性fund_id（選擇規則，依優先序）：
// 1) 只有一個APPROVED成員 -> 選那個
// 2) 多個APPROVED成員時優先選幣別=TWD(新台幣)的
// 3) 沒有TWD選項時，優先選股別關鍵字跟目前(即將被取代的yahoo)代表相同的
// 4) 以上都不適用時，用latest_nav_date最新、code字典序最小做最終tie-break
const MAPPING: Array<{ master_id: string; old_rep: string; new_rep: string; name: string; rule: string }> = [
  { master_id: "06aa58f2-d8cf-57cd-9728-a0f593d1259b", old_rep: "dbf2e464-42db-4a35-aa74-d71b104485f3", new_rep: "88d15b0e-c591-4dcb-9c09-ea3a153c8d02", name: "復華已開發國家300股票指數基金", rule: "唯一APPROVED成員(美元)" },
  { master_id: "221dd23c-9c3a-50ff-8fb3-940ff948b035", old_rep: "473c535c-ece1-4666-bae0-c64607ee4294", new_rep: "1a4462d8-c045-4de3-8035-bf1e8ff946b5", name: "台新美國策略時機非投資等級債券基金", rule: "TWD優先(法人累積型-新臺幣)" },
  { master_id: "26d77328-31ce-5711-a3b2-ab97ca492ce2", old_rep: "0aff98b2-b46e-4a90-ab47-838da88fc2af", new_rep: "4d9d5499-0b72-49a5-b94d-012f216fe965", name: "富蘭克林華美多重資產收益基金", rule: "唯一APPROVED成員(人民幣)" },
  { master_id: "2f21b32c-19a5-5982-a28e-f9d32c185cae", old_rep: "06f57d7d-c0b6-4300-8b3e-711b460b638e", new_rep: "6d5ddf3f-d930-4f7e-9711-753e42161be5", name: "瀚亞全球非投資等級債券基金B類型", rule: "無TWD選項，code字典序最小(澳幣)" },
  { master_id: "3af43739-bf1f-5caf-9f5f-8ad454708db8", old_rep: "343cdb72-2435-4dee-9fd5-5eb53801e0b7", new_rep: "97aaa244-3b9e-4543-ae8b-0846027c3518", name: "摩根環球股票收益基金", rule: "TWD優先(R類型-新臺幣)" },
  { master_id: "505ba3e5-7bc0-514a-bbac-fa5080754863", old_rep: "0657880a-4f7d-4235-a426-b84e1ca90aae", new_rep: "47fad75e-7f91-452e-aa97-4aed4a18399b", name: "富蘭克林華美特別股收益基金", rule: "唯一APPROVED成員(人民幣)" },
  { master_id: "6a86cb0b-ba41-5769-9129-ad2414ffe57a", old_rep: "7c190873-c200-4749-b08e-33d891707267", new_rep: "568e5b4f-5ade-4616-884f-122167bd7451", name: "復華新興市場非投資等級債券基金", rule: "TWD優先(新臺幣A)" },
  { master_id: "924ec78f-f87d-5795-a674-1c3aea465e36", old_rep: "1447b351-f1a6-4f2c-8a3e-682178437eac", new_rep: "bb6e648f-7777-4cda-aaf9-8c54df4a0eab", name: "摩根新興雙利平衡基金", rule: "TWD優先(月配息型-新臺幣)" },
  { master_id: "9cbc4fa0-5f83-5029-8ee1-78be38e7ef05", old_rep: "228da53e-1222-4339-8d6a-b19173bc4f33", new_rep: "3580c7b3-a45e-4987-888f-cb79bbdde328", name: "宏利特別股息收益基金", rule: "無TWD選項，code字典序最小(美元NB)" },
  { master_id: "a3926eef-c63c-5682-9dea-71c37afa4ed6", old_rep: "1784992c-08f1-45a6-8b81-46525be6700d", new_rep: "dbba735b-9cf8-4837-94fe-761dbe5db887", name: "華南永昌多重資產入息平衡基金", rule: "股別關鍵字相同(月配美元)" },
  { master_id: "b78ee7cb-15d4-5419-862b-ed79bd970cb5", old_rep: "3835e7c3-59a1-4ea4-8dc8-2c16ffc46f39", new_rep: "06b22079-e023-48db-a437-76363f92cf72", name: "群益潛力收益多重資產基金", rule: "TWD優先，code字典序最小(月配型B-新臺幣)" },
  { master_id: "c5600a75-83ad-56b7-a8e7-771c5d73764b", old_rep: "02030c71-a3bf-4ab8-852f-9275e0bcda65", new_rep: "32b1a6bb-fc97-4acf-a470-6abecc870a30", name: "瀚亞三至六年到期新興市場收益機會債券基金A類型", rule: "唯一APPROVED成員(人民幣)" },
  { master_id: "c605d5ad-8ac5-56b0-93d0-a01052e9fbfd", old_rep: "2a198bc6-e98f-48af-8ae6-6231a9c3914c", new_rep: "307664cc-47b8-4066-8d83-1deec7571a32", name: "景順2030優享樂活退休組合基金", rule: "無TWD選項，code字典序最小(美元)" },
  { master_id: "d2731f07-d11c-5188-85e7-1d47a0fd6ad7", old_rep: "44bac915-2e36-4e40-8502-8309aea9a269", new_rep: "6371f561-f7e6-4138-b398-75f9c5f7f90d", name: "永豐新興市場企業債券基金", rule: "唯一APPROVED成員(人民幣)" },
  { master_id: "d62ccea1-ff74-543f-91e1-f825c31edd47", old_rep: "3436870e-94f4-496a-a728-35b8c50e60c4", new_rep: "0baeb9eb-ea85-421a-81a0-3beefa45cef9", name: "安聯特別收益多重資產基金", rule: "TWD優先(A類型-新臺幣)" },
  { master_id: "dd021bb7-f5e7-5ef8-a8ba-04d4b68f5628", old_rep: "305cc3fc-e915-4a31-a81c-d73dc33880ea", new_rep: "01fa4e38-52c1-4d83-bdc2-a0fd2ea63ba0", name: "合庫新興多重收益基金", rule: "唯一APPROVED成員(人民幣)" },
  { master_id: "e94ad51a-7427-59f9-a36b-39778b0a519a", old_rep: "1b2e8ead-5566-49d9-9481-6e097511c0e9", new_rep: "2e78fdeb-473f-45a3-b82a-26258a9c5965", name: "柏瑞新興邊境非投資等級債券基金", rule: "唯一APPROVED成員(人民幣)" },
];

async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL });
  await c.connect();

  console.log("mapping_count:", MAPPING.length);

  // Pre-check: confirm each old_rep in DB currently matches, and new_rep is really APPROVED
  for (const m of MAPPING) {
    const check = await c.query(
      `SELECT representative_fund_id FROM fund_master WHERE id = $1`,
      [m.master_id],
    );
    if (check.rows[0]?.representative_fund_id !== m.old_rep) {
      throw new Error(`PRECHECK_FAILED master_id=${m.master_id} expected_old=${m.old_rep} actual=${check.rows[0]?.representative_fund_id}`);
    }
    const approvedCheck = await c.query(
      `SELECT 1 FROM tw_purchasable_classification WHERE asset_type='FUND' AND asset_id=$1 AND status='APPROVED'`,
      [m.new_rep],
    );
    if (approvedCheck.rows.length === 0) {
      throw new Error(`NEW_REP_NOT_APPROVED master_id=${m.master_id} new_rep=${m.new_rep}`);
    }
  }
  console.log("precheck_passed: all 17 old values match DB, all 17 new values are APPROVED");

  // Backup table
  await c.query(`
    CREATE TABLE IF NOT EXISTS fund_master_representative_backup_20261022 (
      master_id text PRIMARY KEY,
      old_representative_fund_id text,
      new_representative_fund_id text,
      fund_name text,
      selection_rule text,
      changed_at timestamptz DEFAULT now()
    )
  `);
  await c.query(`ALTER TABLE fund_master_representative_backup_20261022 ENABLE ROW LEVEL SECURITY`);
  await c.query(`REVOKE ALL ON fund_master_representative_backup_20261022 FROM anon, authenticated`);

  const rls = await c.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'fund_master_representative_backup_20261022'`);
  const grants = await c.query(`
    SELECT grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_name = 'fund_master_representative_backup_20261022' AND grantee IN ('anon','authenticated')
  `);
  console.log("backup_table_rls_enabled:", rls.rows[0]?.relrowsecurity);
  console.log("backup_table_anon_authenticated_grants (should be empty):", JSON.stringify(grants.rows));

  // Single transaction: insert backup rows + update all 17
  await c.query("BEGIN");
  try {
    for (const m of MAPPING) {
      await c.query(
        `INSERT INTO fund_master_representative_backup_20261022
         (master_id, old_representative_fund_id, new_representative_fund_id, fund_name, selection_rule)
         VALUES ($1,$2,$3,$4,$5)`,
        [m.master_id, m.old_rep, m.new_rep, m.name, m.rule],
      );
      const upd = await c.query(
        `UPDATE fund_master SET representative_fund_id = $2 WHERE id = $1 AND representative_fund_id = $3`,
        [m.master_id, m.new_rep, m.old_rep],
      );
      if (upd.rowCount !== 1) throw new Error(`UPDATE_ROWCOUNT_MISMATCH master_id=${m.master_id} rowCount=${upd.rowCount}`);
    }
    await c.query("COMMIT");
    console.log("transaction_committed: 17 backup rows inserted, 17 fund_master rows updated");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }

  // Post-check
  const backupCount = await c.query(`SELECT count(*)::int n FROM fund_master_representative_backup_20261022`);
  console.log("backup_table_row_count:", backupCount.rows[0].n);

  const postCheck = await c.query(`
    SELECT fm.id, fm.representative_fund_id,
           EXISTS(SELECT 1 FROM tw_purchasable_classification t WHERE t.asset_type='FUND' AND t.asset_id=fm.representative_fund_id AND t.status='APPROVED') AS rep_is_approved
    FROM fund_master fm WHERE fm.id = ANY($1::text[])
  `, [MAPPING.map((m) => m.master_id)]);
  const stillNotApproved = postCheck.rows.filter((r: any) => !r.rep_is_approved);
  console.log("post_check_all_17_now_approved:", stillNotApproved.length === 0, "stillNotApproved:", JSON.stringify(stillNotApproved));

  await c.end();
}
main().catch((e) => { console.error("FAILED", e); process.exit(1); });
