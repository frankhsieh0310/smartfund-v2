// Focused validation for the Diff API's core logic (loadFrontendDiff), inside a transaction that is
// always ROLLED BACK. No permanent write, no real ETF touched — uses synthetic test codes
// ("__TEST_DIFF_A__", "__TEST_DIFF_B__") that don't collide with any real ticker.
import { Client } from "pg";
import { upsertSnapshot, loadFrontendDiff, type QueryFn } from "../lib/etf-holdings-engine/storage.ts";
import type { CanonicalSnapshot } from "../lib/etf-holdings-engine/types.ts";

function snap(etfCode: string, dataDate: string, positions: CanonicalSnapshot["positions"]): CanonicalSnapshot {
  return {
    etfCode, issuer: "TEST", assetType: "EQUITY", dataDate, announcementDate: dataDate,
    fundNav: 1_000_000, outstandingUnits: 100_000, positions, source: "TEST", retrievedAt: new Date().toISOString(),
  };
}

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  const query: QueryFn = async (sql, params) => (await client.query(sql, params)).rows;
  const results: Record<string, unknown> = {};

  await client.query("BEGIN");
  try {
    // Case 1: one snapshot only -> loadFrontendDiff must throw NOT_ENOUGH_SNAPSHOTS_
    await upsertSnapshot(query, snap("__TEST_DIFF_A__", "2026-09-24", [
      { securityCode: "S1", securityName: "Stock1", positionType: "EQUITY", positionAmount: 1000, positionUnit: "SHARES", weight: 10, canonicalSecurityId: null },
    ]));
    try {
      await loadFrontendDiff(query, "__TEST_DIFF_A__");
      results.ONE_SNAPSHOT_STATE = "FAIL (should have thrown)";
    } catch (e) {
      results.ONE_SNAPSHOT_STATE = (e instanceof Error && e.message.includes("NOT_ENOUGH_SNAPSHOTS")) ? "PASS" : `FAIL (${e})`;
    }

    // Case 1b: same-date re-upsert must NOT create a second distinct dataDate row (idempotent) —
    // re-running loadFrontendDiff should still be the one-snapshot state, not a same-date "diff".
    await upsertSnapshot(query, snap("__TEST_DIFF_A__", "2026-09-24", [
      { securityCode: "S1", securityName: "Stock1", positionType: "EQUITY", positionAmount: 1500, positionUnit: "SHARES", weight: 12, canonicalSecurityId: null },
    ]));
    const sameDateCount = await client.query(`SELECT COUNT(*) c FROM etf_official_daily_snapshots WHERE etf_code = 'S__TEST_DIFF_A__'`);
    try {
      await loadFrontendDiff(query, "__TEST_DIFF_A__");
      results.SAME_DATE_NOT_DIFFED = "FAIL (should still be one-snapshot)";
    } catch (e) {
      results.SAME_DATE_NOT_DIFFED = (e instanceof Error && e.message.includes("NOT_ENOUGH_SNAPSHOTS")) ? "PASS" : `FAIL (${e})`;
    }

    // Case 2: two different dataDates -> real diff with ADDED/REMOVED/INCREASED/DECREASED/UNCHANGED
    await upsertSnapshot(query, snap("__TEST_DIFF_B__", "2026-09-23", [
      { securityCode: "S1", securityName: "Stock1", positionType: "EQUITY", positionAmount: 1000, positionUnit: "SHARES", weight: 10, canonicalSecurityId: null },
      { securityCode: "S2", securityName: "Stock2", positionType: "EQUITY", positionAmount: 2000, positionUnit: "SHARES", weight: 20, canonicalSecurityId: null },
      { securityCode: "S3", securityName: "Stock3", positionType: "EQUITY", positionAmount: 3000, positionUnit: "SHARES", weight: 30, canonicalSecurityId: null },
      { securityCode: "S4", securityName: "Stock4", positionType: "EQUITY", positionAmount: 4000, positionUnit: "SHARES", weight: 40, canonicalSecurityId: null },
    ]));
    await upsertSnapshot(query, snap("__TEST_DIFF_B__", "2026-09-24", [
      { securityCode: "S1", securityName: "Stock1", positionType: "EQUITY", positionAmount: 1000, positionUnit: "SHARES", weight: 10, canonicalSecurityId: null }, // unchanged
      { securityCode: "S2", securityName: "Stock2", positionType: "EQUITY", positionAmount: 2500, positionUnit: "SHARES", weight: 22, canonicalSecurityId: null }, // increased
      { securityCode: "S3", securityName: "Stock3", positionType: "EQUITY", positionAmount: 1000, positionUnit: "SHARES", weight: 12, canonicalSecurityId: null }, // decreased
      // S4 removed
      { securityCode: "S5", securityName: "Stock5", positionType: "EQUITY", positionAmount: 500, positionUnit: "SHARES", weight: 5, canonicalSecurityId: null }, // added
    ]));
    const diff = await loadFrontendDiff(query, "__TEST_DIFF_B__");
    const byCode = new Map(diff.changes.map((c) => [c.code, c.action]));
    const expected = { S1: "UNCHANGED", S2: "INCREASED", S3: "DECREASED", S4: "REMOVED", S5: "ADDED" };
    const mismatches = Object.entries(expected).filter(([code, action]) => byCode.get(code) !== action);
    results.TWO_DIFFERENT_DATES_DIFF = mismatches.length === 0 && diff.dateFrom === "2026-09-23" && diff.dateTo === "2026-09-24" ? "PASS" : `FAIL (${JSON.stringify(mismatches)}, dates=${diff.dateFrom}->${diff.dateTo})`;
    results.diffSummary = { addedCount: diff.addedCount, removedCount: diff.removedCount, increasedCount: diff.increasedCount, decreasedCount: diff.decreasedCount, unchangedCount: diff.unchangedCount };
  } finally {
    await client.query("ROLLBACK");
  }

  const after = await client.query(`SELECT COUNT(*) c FROM etf_official_daily_snapshots WHERE etf_code IN ('__TEST_DIFF_A__','__TEST_DIFF_B__')`);
  results.ROLLBACK_CONFIRMED = after.rows[0].c === "0";
  await client.end();
  console.log(JSON.stringify(results, null, 2));
}
main();
