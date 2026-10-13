// Focused correctness test for the generalized Taiwan ETF Official Daily Holdings Engine. Calls two
// issuers' official public APIs (no third party, no scraping infra), builds canonical snapshots on the
// new positions[] model, runs the shared diff engine, and asserts the fund-size normalization still holds
// after generalizing from holdings/futures to a single typed positions array. No production write.
import { NomuraOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/nomura.ts";
import { UpamcOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/upamc.ts";
import { diffSnapshots } from "../lib/etf-holdings-engine/diffEngine.ts";
import type { CanonicalSnapshot } from "../lib/etf-holdings-engine/types.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION_FAILED: ${msg}`);
}

function validateSnapshot(s: CanonicalSnapshot, label: string) {
  assert(!!s.etfCode, `${label}: etfCode missing`);
  assert(!!s.dataDate, `${label}: dataDate missing`);
  assert(s.fundNav > 0, `${label}: fundNav not positive`);
  assert(s.outstandingUnits > 0, `${label}: outstandingUnits not positive`);
  assert(s.positions.length > 10, `${label}: positions.length <= 10 (${s.positions.length}) — looks like a top-N slice, not full portfolio`);
  for (const p of s.positions) {
    assert(typeof p.securityCode === "string" && p.securityCode.length > 0, `${label}: position missing code`);
    assert(typeof p.positionAmount === "number" && p.positionAmount >= 0, `${label}: ${p.securityCode} bad positionAmount`);
    assert(typeof p.weight === "number", `${label}: ${p.securityCode} bad weight`);
    assert(["EQUITY", "BOND", "FUTURE", "OPTION", "OTHER"].includes(p.positionType), `${label}: ${p.securityCode} bad positionType`);
    assert(["SHARES", "PAR_VALUE", "CONTRACTS", "OTHER"].includes(p.positionUnit), `${label}: ${p.securityCode} bad positionUnit`);
    // The generalization's core invariant: equity never coerced into anything but shares.
    if (p.positionType === "EQUITY") assert(p.positionUnit === "SHARES", `${label}: ${p.securityCode} EQUITY position must use SHARES, got ${p.positionUnit}`);
  }
}

async function main() {
  const report: Record<string, unknown> = {};

  // ---- 00980A (Nomura) ----
  {
    const dates = await NomuraOfficialPcfAdapter.listAvailableDates!("00980A");
    const [latest, prev] = dates; // newest first
    const snapLatest = await NomuraOfficialPcfAdapter.fetchSnapshot("00980A", latest);
    const snapPrev = await NomuraOfficialPcfAdapter.fetchSnapshot("00980A", prev);
    validateSnapshot(snapLatest, "00980A latest");
    validateSnapshot(snapPrev, "00980A prev");
    const diff = diffSnapshots(snapPrev, snapLatest);
    const counts = tally(diff.entries.map((e) => e.status));
    report["00980A_SNAPSHOT_PASS"] = true;
    report["00980A_DIFF_PASS"] = true;
    report["00980A_dates"] = { latest, prev };
    report["00980A_positionsCount"] = { latest: snapLatest.positions.length, prev: snapPrev.positions.length };
    report["00980A_diffCounts"] = counts;
    report["00980A_outstandingUnitsChangePct"] = diff.outstandingUnitsChangePct;
    report["00980A_sample_UNIT_HOLDING_changes"] = diff.entries.filter((e) => e.status === "UNIT_HOLDING_UP" || e.status === "UNIT_HOLDING_DOWN").slice(0, 5);
  }

  // ---- 00981A (UPAMC) ----
  {
    const snapLatest = await UpamcOfficialPcfAdapter.fetchSnapshot("00981A", "115/09/29");
    const snapPrev = await UpamcOfficialPcfAdapter.fetchSnapshot("00981A", "115/09/24");
    validateSnapshot(snapLatest, "00981A latest");
    validateSnapshot(snapPrev, "00981A prev");
    const diff = diffSnapshots(snapPrev, snapLatest);
    const counts = tally(diff.entries.map((e) => e.status));
    report["00981A_SNAPSHOT_PASS"] = true;
    report["00981A_DIFF_PASS"] = true;
    report["00981A_dates"] = { latest: snapLatest.dataDate, prev: snapPrev.dataDate };
    report["00981A_positionsCount"] = { latest: snapLatest.positions.length, prev: snapPrev.positions.length };
    report["00981A_diffCounts"] = counts;
    report["00981A_outstandingUnitsChangePct"] = diff.outstandingUnitsChangePct;
    report["00981A_sample_UNIT_HOLDING_changes"] = diff.entries.filter((e) => e.status === "UNIT_HOLDING_UP" || e.status === "UNIT_HOLDING_DOWN").slice(0, 5);
  }

  console.log(JSON.stringify(report, null, 2));
  console.log("ALL ASSERTIONS PASSED");
}

function tally(statuses: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
  return out;
}

main().catch((e) => { console.error("POC_FAILED:", e); process.exit(1); });
