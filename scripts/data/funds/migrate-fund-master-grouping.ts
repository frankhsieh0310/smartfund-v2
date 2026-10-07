// Deterministic migration for the 5 Yahoo-US-MF fund_master groups that were mis-grouped by the
// pre-fix masterStem() (see lib/yahoo/fundIngest.ts, SUFFIX_RE). Those 5 masters (Fidelity, Russell,
// Morgan Stanley, Columbia, VALIC Company) each collapsed many genuinely different underlying funds
// down to one master, because the old regex stripped from the first occurrence of a share-class-like
// word (Advisor/Inv/Inst/Select) instead of only a trailing suffix.
//
// This migration ONLY rewrites fund_share_classes.master_fund_id and fund_master rows for the 811
// affected rows under those 5 OLD masters. It never touches:
//   - the `holdings` table (no Yahoo holdings value is read, written, or recomputed)
//   - any other fund_master group (the 5 previously-confirmed-correct 東方匯理/路博邁 TW groups
//     and the ~9,133 other masters are untouched — this script only ever reads/writes rows whose
//     CURRENT master_fund_id is one of the 5 OLD_BROKEN_MASTER_IDS below)
//   - share-class NAV / currency / distribution / fees / ISIN columns
//
// Usage:
//   npx tsx scripts/data/funds/migrate-fund-master-grouping.ts            (dry-run, default, no writes)
//   npx tsx scripts/data/funds/migrate-fund-master-grouping.ts --apply    (writes; refused outside this guard)
//
// Safety guard: the script recomputes the affected row count via masterStem() and refuses to do
// anything (including dry-run reporting beyond the count) if it does not equal exactly 811 — the
// count independently confirmed during diagnosis. This catches drift between diagnosis and migration
// time (e.g. new Yahoo ingest rows landing under these masters in between).
import { Client } from "pg";
import { masterStem } from "../../../lib/yahoo/fundIngest";

const OLD_BROKEN_MASTER_IDS: Record<string, string> = {
  "34566cf2-82d3-4dcc-bdc7-8c5b59e243a0": "Fidelity",
  "02315ede-8a50-4809-a9cc-0ca525d11d16": "Russell",
  "212a169c-693d-4fb7-b1ab-e2b93b235908": "Morgan Stanley",
  "b9d702f4-936a-45db-b2c4-39cd4e9dcf2e": "Columbia",
  "8b4329d0-6f05-4135-8c94-36eb70004df4": "VALIC Company",
};
const EXPECTED_AFFECTED_ROWS = 811;

type AffectedRow = { master_fund_id: string; share_class_id: string; fund_id: string; name: string; currency: string | null };

async function loadAffectedRows(query: (sql: string, params?: any[]) => Promise<any[]>): Promise<AffectedRow[]> {
  return query(
    `SELECT sc.master_fund_id, sc.id AS share_class_id, f.id AS fund_id, f.name, sc.currency
     FROM fund_share_classes sc JOIN funds f ON f.id = sc.fund_id
     WHERE sc.master_fund_id = ANY($1::text[])`,
    [Object.keys(OLD_BROKEN_MASTER_IDS)],
  );
}

type NewCluster = { stem: string; oldMasterId: string; oldMasterName: string; rows: AffectedRow[] };

function buildPlan(rows: AffectedRow[]): NewCluster[] {
  const clusters = new Map<string, NewCluster>();
  for (const r of rows) {
    const stem = masterStem(r.name);
    const key = `${r.master_fund_id}::${stem}`;
    if (!clusters.has(key)) {
      clusters.set(key, { stem, oldMasterId: r.master_fund_id, oldMasterName: OLD_BROKEN_MASTER_IDS[r.master_fund_id], rows: [] });
    }
    clusters.get(key)!.rows.push(r);
  }
  return [...clusters.values()];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");
  const client = new Client({ connectionString });
  await client.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params).then((r) => r.rows);

  try {
    const rows = await loadAffectedRows(query);

    // --- Mandatory guard: abort before any further action (dry-run report or write) if the count drifted. ---
    if (rows.length !== EXPECTED_AFFECTED_ROWS) {
      console.error(
        `MIGRATION_GUARD: ABORT — expected exactly ${EXPECTED_AFFECTED_ROWS} affected rows under the 5 broken masters, found ${rows.length}. ` +
          `Refusing to proceed (no reads/writes beyond the count check).`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`MIGRATION_GUARD: PASS — ${rows.length} affected rows (expected ${EXPECTED_AFFECTED_ROWS})`);

    const plan = buildPlan(rows);
    console.log(`\nDRY_RUN_NEW_MASTER_COUNT: ${plan.length}`);

    const byOldMaster = new Map<string, NewCluster[]>();
    for (const c of plan) {
      if (!byOldMaster.has(c.oldMasterId)) byOldMaster.set(c.oldMasterId, []);
      byOldMaster.get(c.oldMasterId)!.push(c);
    }
    for (const [oldId, clusters] of byOldMaster) {
      const totalRows = clusters.reduce((n, c) => n + c.rows.length, 0);
      console.log(`\nOLD_MASTER=${OLD_BROKEN_MASTER_IDS[oldId]} (${oldId}): ${totalRows} rows -> ${clusters.length} NEW_MASTER groups`);
      for (const c of clusters.sort((a, b) => b.rows.length - a.rows.length).slice(0, 5)) {
        console.log(`  NEW_MASTER stem="${c.stem}" rows=${c.rows.length} e.g. ${c.rows.slice(0, 2).map((r) => r.name).join(" / ")}`);
      }
      if (clusters.length > 5) console.log(`  ... and ${clusters.length - 5} more`);
    }

    if (!apply) {
      console.log("\nDRY_RUN only — no writes performed. Re-run with --apply to write (still requires separate explicit authorization this round).");
      return;
    }

    // --apply path exists for completeness but is intentionally not authorized to run this round
    // (user instruction: "先不要 Production write"). It still re-validates the guard above before
    // doing anything, and only ever touches fund_master + fund_share_classes.master_fund_id.
    throw new Error("PRODUCTION_WRITE_NOT_AUTHORIZED_THIS_ROUND");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
