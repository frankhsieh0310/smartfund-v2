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
//     and the ~9,133 other masters are untouched — every statement in this script is scoped with
//     `WHERE master_fund_id = ANY(OLD_BROKEN_MASTER_IDS)` or an id list derived from it)
//   - share-class NAV / currency / distribution / fees / ISIN columns
//
// Usage:
//   npx tsx scripts/data/funds/migrate-fund-master-grouping.ts            (dry-run: runs the full
//                                                                          transaction below, then
//                                                                          always ROLLBACKs — proves
//                                                                          the real write SQL would
//                                                                          succeed, writes nothing)
//   npx tsx scripts/data/funds/migrate-fund-master-grouping.ts --apply    (writes: COMMITs only if
//                                                                          every validation passes)
//
// Atomicity: everything below — the guard check, the source-master-id check, the new fund_master
// INSERTs, the fund_share_classes UPDATEs, the old-master tombstone, and the post-migration
// verification — runs inside one BEGIN/COMMIT. Any failed check calls ROLLBACK and the script exits
// non-zero; partial writes are not possible. --apply is the only thing that turns the trailing
// COMMIT into a real commit; without it, the same transaction is always rolled back.
import { Client } from "pg";
import { masterStem, SUFFIX_RE } from "../../../lib/yahoo/fundIngest";

const OLD_BROKEN_MASTER_IDS: Record<string, string> = {
  "34566cf2-82d3-4dcc-bdc7-8c5b59e243a0": "Fidelity",
  "02315ede-8a50-4809-a9cc-0ca525d11d16": "Russell",
  "212a169c-693d-4fb7-b1ab-e2b93b235908": "Morgan Stanley",
  "b9d702f4-936a-45db-b2c4-39cd4e9dcf2e": "Columbia",
  "8b4329d0-6f05-4135-8c94-36eb70004df4": "VALIC Company",
};
const EXPECTED_AFFECTED_ROWS = 811;
const YAHOO_FUND_HOLDINGS_SOURCES = ["YAHOO_QUOTE_SUMMARY", "YAHOO_TW_FUND"];

type AffectedRow = {
  master_fund_id: string;
  share_class_id: string;
  fund_id: string;
  name: string;
  currency: string | null;
  provider_master_key: string;
};

type NewCluster = {
  stem: string;
  oldMasterId: string;
  oldMasterName: string;
  family: string;
  rows: AffectedRow[];
  representativeFundId: string;
  representativeHasHoldings: boolean;
};

function familyFromProviderMasterKey(key: string): string {
  // "YAHOO:Fidelity Investments|fidelity" -> "Fidelity Investments"
  const noPrefix = key.replace(/^YAHOO:/, "");
  const bar = noPrefix.indexOf("|");
  return bar === -1 ? noPrefix : noPrefix.slice(0, bar);
}

function buildPlan(rows: AffectedRow[]): NewCluster[] {
  const clusters = new Map<string, NewCluster>();
  for (const r of rows) {
    const stem = masterStem(r.name);
    const key = `${r.master_fund_id}::${stem}`;
    if (!clusters.has(key)) {
      clusters.set(key, {
        stem,
        oldMasterId: r.master_fund_id,
        oldMasterName: OLD_BROKEN_MASTER_IDS[r.master_fund_id],
        family: familyFromProviderMasterKey(r.provider_master_key),
        rows: [],
        representativeFundId: "",
        representativeHasHoldings: false,
      });
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

  let committed = false;
  try {
    await query("BEGIN");

    // --- Step 1: load affected rows, locking them against concurrent ingestion while this runs. ---
    const rows: AffectedRow[] = await query(
      `SELECT sc.master_fund_id, sc.id AS share_class_id, f.id AS fund_id, f.name, sc.currency, fm.provider_master_key
       FROM fund_share_classes sc
       JOIN funds f ON f.id = sc.fund_id
       JOIN fund_master fm ON fm.id = sc.master_fund_id
       WHERE sc.master_fund_id = ANY($1::text[])
       FOR UPDATE OF sc`,
      [Object.keys(OLD_BROKEN_MASTER_IDS)],
    );

    // --- Step 2: guard — exact row count. ---
    if (rows.length !== EXPECTED_AFFECTED_ROWS) {
      console.error(
        `MIGRATION_GUARD: ABORT — expected exactly ${EXPECTED_AFFECTED_ROWS} affected rows under the 5 broken masters, found ${rows.length}.`,
      );
      await query("ROLLBACK");
      process.exitCode = 1;
      return;
    }

    // --- Step 3: guard — source master IDs are exactly the 5 confirmed-broken ones, nothing else. ---
    const foundMasterIds = new Set(rows.map((r) => r.master_fund_id));
    const expectedMasterIds = new Set(Object.keys(OLD_BROKEN_MASTER_IDS));
    const unexpected = [...foundMasterIds].filter((id) => !expectedMasterIds.has(id));
    const missing = [...expectedMasterIds].filter((id) => !foundMasterIds.has(id));
    if (unexpected.length || missing.length) {
      console.error("MIGRATION_GUARD: ABORT — source master ID set does not match the 5 confirmed-broken masters.", { unexpected, missing });
      await query("ROLLBACK");
      process.exitCode = 1;
      return;
    }
    console.log(`MIGRATION_GUARD: PASS — ${rows.length} affected rows across exactly the 5 confirmed-broken masters`);

    // --- Step 4: build the new grouping plan (pure function, same as the diagnosis dry-run). ---
    const plan = buildPlan(rows);
    console.log(`DRY_RUN_NEW_MASTER_COUNT: ${plan.length}`);

    // --- Step 5: pick a representative_fund_id per new cluster. Never arbitrary across funds —
    //     only ever a member of THIS cluster, and preferentially the member that actually carries
    //     real Yahoo holdings, so the new master never points at a different fund's portfolio. ---
    const allFundIds = rows.map((r) => r.fund_id);
    const holdingsCounts: { fund_id: string; n: number }[] = await query(
      `SELECT fund_id, count(*)::int AS n FROM holdings
       WHERE asset_type = 'FUND' AND source = ANY($1::text[]) AND fund_id = ANY($2::text[])
       GROUP BY fund_id`,
      [YAHOO_FUND_HOLDINGS_SOURCES, allFundIds],
    );
    const holdingsCountByFund = new Map(holdingsCounts.map((r) => [r.fund_id, r.n]));

    for (const cluster of plan) {
      const withHoldings = cluster.rows
        .map((r) => ({ fund_id: r.fund_id, n: holdingsCountByFund.get(r.fund_id) ?? 0 }))
        .filter((r) => r.n > 0)
        .sort((a, b) => b.n - a.n || a.fund_id.localeCompare(b.fund_id));
      if (withHoldings.length) {
        cluster.representativeFundId = withHoldings[0].fund_id;
        cluster.representativeHasHoldings = true;
      } else {
        // No member has Yahoo holdings yet: pick deterministically (lowest fund_id). Harmless —
        // there is no holdings row to misattribute, so this master will honestly show "unavailable".
        cluster.representativeFundId = [...cluster.rows].sort((a, b) => a.fund_id.localeCompare(b.fund_id))[0].fund_id;
        cluster.representativeHasHoldings = false;
      }
    }

    // --- Step 6: insert the new fund_master rows. ---
    const newMasterIdByClusterKey = new Map<NewCluster, string>();
    for (const cluster of plan) {
      const sampleName = cluster.rows[0].name;
      const canonicalName = (sampleName.replace(SUFFIX_RE, "").trim() || sampleName).slice(0, 240);
      const currency = cluster.rows.find((r) => r.fund_id === cluster.representativeFundId)?.currency ?? cluster.rows[0].currency;
      const providerMasterKey = `YAHOO:${cluster.family}|${cluster.stem}`.slice(0, 200);
      const inserted = await query(
        `INSERT INTO fund_master (id, canonical_name, base_currency, provider_master_key, representative_fund_id, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), NOW())
         RETURNING id::text`,
        [canonicalName, currency, providerMasterKey, cluster.representativeFundId],
      );
      newMasterIdByClusterKey.set(cluster, inserted[0].id);
    }

    // --- Step 7: repoint the 811 share classes at their new master. ---
    let totalUpdated = 0;
    for (const cluster of plan) {
      const newMasterId = newMasterIdByClusterKey.get(cluster)!;
      const shareClassIds = cluster.rows.map((r) => r.share_class_id);
      const updated = await query(
        `UPDATE fund_share_classes SET master_fund_id = $1, updated_at = NOW() WHERE id = ANY($2::text[]) RETURNING id`,
        [newMasterId, shareClassIds],
      );
      totalUpdated += updated.length;
    }

    // --- Step 8: tombstone the 5 old broken masters so no future ingestion run can ever re-attach
    //     to them by provider_master_key (defense in depth — the masterStem() code fix already means
    //     a future run computes a different key and will never produce this old one again). Not
    //     deleted, so nothing that happens to still reference the id by FK breaks. ---
    const oldIds = Object.keys(OLD_BROKEN_MASTER_IDS);
    await query(
      `UPDATE fund_master
       SET provider_master_key = 'DEPRECATED:' || provider_master_key,
           canonical_name = '[DEPRECATED — split by fund-master-grouping migration] ' || canonical_name,
           updated_at = NOW()
       WHERE id = ANY($1::text[]) AND provider_master_key NOT LIKE 'DEPRECATED:%'`,
      [oldIds],
    );

    // --- Step 9: verify the new grouping before allowing COMMIT. ---
    const newMasterIds = [...newMasterIdByClusterKey.values()];

    const stillOnOld = (await query(`SELECT count(*)::int AS n FROM fund_share_classes WHERE master_fund_id = ANY($1::text[])`, [oldIds]))[0].n;
    const nowOnNew = (await query(`SELECT count(*)::int AS n FROM fund_share_classes WHERE master_fund_id = ANY($1::text[])`, [newMasterIds]))[0].n;

    // Every new master's representative_fund_id must belong to a share class that is itself in
    // that same new master — i.e. the representative is never a different fund than the one its
    // own share classes claim to be, which is exactly "must not arbitrarily point at a different
    // fund's holdings."
    const representativeIntegrity = await query(
      `SELECT fm.id, fm.representative_fund_id
       FROM fund_master fm
       WHERE fm.id = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM fund_share_classes sc WHERE sc.master_fund_id = fm.id AND sc.fund_id = fm.representative_fund_id
         )`,
      [newMasterIds],
    );

    const totalRowsOk = totalUpdated === EXPECTED_AFFECTED_ROWS && nowOnNew === EXPECTED_AFFECTED_ROWS && stillOnOld === 0;
    const representativeOk = representativeIntegrity.length === 0;
    const clusterCountOk = newMasterIds.length === plan.length;

    console.log("\nVERIFICATION:");
    console.log("  rows updated:", totalUpdated, "(expected", EXPECTED_AFFECTED_ROWS, ") ->", totalRowsOk ? "PASS" : "FAIL");
    console.log("  rows still on old masters:", stillOnOld, "-> expected 0 ->", stillOnOld === 0 ? "PASS" : "FAIL");
    console.log("  rows now on new masters:", nowOnNew, "-> expected", EXPECTED_AFFECTED_ROWS, "->", nowOnNew === EXPECTED_AFFECTED_ROWS ? "PASS" : "FAIL");
    console.log("  representative_fund_id integrity (0 violations expected):", representativeIntegrity.length, "->", representativeOk ? "PASS" : "FAIL");
    console.log("  new master count matches plan:", newMasterIds.length, "==", plan.length, "->", clusterCountOk ? "PASS" : "FAIL");

    const sampleByOld = new Map<string, NewCluster[]>();
    for (const c of plan) {
      if (!sampleByOld.has(c.oldMasterId)) sampleByOld.set(c.oldMasterId, []);
      sampleByOld.get(c.oldMasterId)!.push(c);
    }
    for (const [oldId, clusters] of sampleByOld) {
      const totalRows = clusters.reduce((n, c) => n + c.rows.length, 0);
      console.log(`\nOLD_MASTER=${OLD_BROKEN_MASTER_IDS[oldId]} (${oldId}): ${totalRows} rows -> ${clusters.length} NEW_MASTER groups`);
      for (const c of clusters.sort((a, b) => b.rows.length - a.rows.length).slice(0, 3)) {
        const newId = newMasterIdByClusterKey.get(c)!;
        console.log(
          `  NEW_MASTER ${newId} stem="${c.stem}" rows=${c.rows.length} representative=${c.representativeFundId}${c.representativeHasHoldings ? " (has Yahoo holdings)" : " (no Yahoo holdings yet)"} e.g. ${c.rows
            .slice(0, 2)
            .map((r) => r.name)
            .join(" / ")}`,
        );
      }
      if (clusters.length > 3) console.log(`  ... and ${clusters.length - 3} more`);
    }

    const allOk = totalRowsOk && representativeOk && clusterCountOk;
    if (!allOk) {
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
    console.log("\nCOMMIT: migration applied.");
  } catch (e) {
    try {
      await query("ROLLBACK");
    } catch {
      // connection may already be unusable after the original error; nothing more to do
    }
    throw e;
  } finally {
    await client.end();
    if (!committed) console.log("\n(transaction was rolled back; Production is unchanged)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
