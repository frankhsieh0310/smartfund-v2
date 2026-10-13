// Shared daily-change engine for canonical ETF holdings snapshots. One implementation, every issuer,
// every asset type. Deliberately does NOT call any status "manager buy" / "manager sell" — a fund-size
// normalized change is a fact about the snapshot, not a claim about intent (see amountPerUnit below).
import type { CanonicalPosition, CanonicalSnapshot, PositionType, PositionUnit } from "./types.ts";

export type HoldingChangeStatus = "ADDED" | "REMOVED" | "UNIT_HOLDING_UP" | "UNIT_HOLDING_DOWN" | "UNCHANGED";

export type HoldingDiffEntry = {
  code: string;
  name: string;
  positionType: PositionType;
  positionUnit: PositionUnit;
  status: HoldingChangeStatus;
  /** Raw position-amount delta, in the position's own unit. Kept for audit/inspection — never itself the
   * basis for status when fund size (outstandingUnits) also moved, since a proportional creation/
   * redemption changes every position's raw amount without any active decision by the manager. */
  rawAmountChange: number | null;
  weightChange: number | null;
  rankChange: number | null;
};

export type DiffResult = {
  etfCode: string;
  fromDate: string;
  toDate: string;
  outstandingUnitsChange: number;
  outstandingUnitsChangePct: number;
  entries: HoldingDiffEntry[];
};

function amountPerUnit(p: CanonicalPosition, outstandingUnits: number): number {
  return outstandingUnits ? p.positionAmount / outstandingUnits : 0;
}

function rankOf(snapshot: CanonicalSnapshot): Map<string, number> {
  const sorted = [...snapshot.positions].sort((a, b) => b.weight - a.weight);
  return new Map(sorted.map((p, i) => [p.securityCode, i + 1]));
}

/**
 * Compares two canonical snapshots of the SAME ETF (caller's responsibility to pass the correct pair —
 * this engine does not select "previous available" itself, since availability differs per issuer).
 *
 * Status is decided on `positionAmount / outstandingUnits` ("amount per unit"), not raw positionAmount:
 * that ratio is invariant under pure proportional creation/redemption, so only a genuine active rebalance
 * moves it. This applies uniformly whether the position's own unit is SHARES, PAR_VALUE, or CONTRACTS —
 * the normalization is against fund size, never against a cross-asset-type conversion.
 */
export function diffSnapshots(from: CanonicalSnapshot, to: CanonicalSnapshot): DiffResult {
  if (from.etfCode !== to.etfCode) throw new Error(`DIFF_ETF_MISMATCH: ${from.etfCode} vs ${to.etfCode}`);

  const fromMap = new Map(from.positions.map((p) => [p.securityCode, p]));
  const toMap = new Map(to.positions.map((p) => [p.securityCode, p]));
  const fromRank = rankOf(from);
  const toRank = rankOf(to);

  const codes = new Set([...fromMap.keys(), ...toMap.keys()]);
  const entries: HoldingDiffEntry[] = [];

  for (const code of codes) {
    const f = fromMap.get(code);
    const t = toMap.get(code);

    if (!f && t) {
      entries.push({
        code, name: t.securityName, positionType: t.positionType, positionUnit: t.positionUnit,
        status: "ADDED", rawAmountChange: t.positionAmount, weightChange: t.weight, rankChange: null,
      });
      continue;
    }
    if (f && !t) {
      entries.push({
        code, name: f.securityName, positionType: f.positionType, positionUnit: f.positionUnit,
        status: "REMOVED", rawAmountChange: -f.positionAmount, weightChange: -f.weight, rankChange: null,
      });
      continue;
    }
    if (f && t) {
      const fApu = amountPerUnit(f, from.outstandingUnits);
      const tApu = amountPerUnit(t, to.outstandingUnits);
      const apuDelta = tApu - fApu;
      // small epsilon guards floating-point noise from the division, not a semantic threshold
      const status: HoldingChangeStatus = apuDelta > 1e-12 ? "UNIT_HOLDING_UP" : apuDelta < -1e-12 ? "UNIT_HOLDING_DOWN" : "UNCHANGED";
      const rc = (toRank.get(code) ?? 0) - (fromRank.get(code) ?? 0);
      entries.push({
        code, name: t.securityName, positionType: t.positionType, positionUnit: t.positionUnit, status,
        rawAmountChange: t.positionAmount - f.positionAmount,
        weightChange: t.weight - f.weight,
        rankChange: rc,
      });
    }
  }

  const unitsChange = to.outstandingUnits - from.outstandingUnits;
  return {
    etfCode: to.etfCode,
    fromDate: from.dataDate,
    toDate: to.dataDate,
    outstandingUnitsChange: unitsChange,
    outstandingUnitsChangePct: from.outstandingUnits ? unitsChange / from.outstandingUnits : 0,
    entries,
  };
}
