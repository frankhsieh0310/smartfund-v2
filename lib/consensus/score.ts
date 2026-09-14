// SmartMatch 共識雷達 — deterministic consensus scoring (Phase H).
//
// The LLM never produces a total score. It only classifies one event. This module turns a set of
// classified per-person / per-stock links into a reproducible number.
//
// CONSENSUS_SCORE_FORMULA (per stock, per window):
//
//   consensus_score = Σ_person  clamp( Σ_link linkScore(link) , -1 , +1 )
//
//   where, per person, links for the SAME (stock, direction) within 24h collapse to ONE vote
//   (max |contribution| = 1 before source/relation weighting), and:
//
//   linkScore(link) = stanceVote(stance)
//                   * SOURCE_WEIGHT[grade]      // A 1.00 | B 0.85 | C 0.00 (C = discovery only)
//                   * RELATION_WEIGHT[relation] // DIRECT 1.00 | INFERRED 0.40
//                   * clamp(statement_strength, 0.5, 1.0)
//                   * clamp(confidence,         0.5, 1.0)
//                   * freshnessDecay(window, ageHours)
//
//   stanceVote: BULLISH +1 | BEARISH -1 | NEUTRAL 0 | MIXED ±0.25 (resolved dir) or 0 | UNCLEAR 0
//   NO_VIEW  -> no link row is created at all (NO_VIEW != NEUTRAL).
//
//   trend_score = consensus_score(current window) - consensus_score(previous comparable window)

export type Stance = "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED" | "UNCLEAR";
export type Relation = "DIRECT" | "INFERRED";
export type Grade = "A" | "B" | "C";
export type Window = "1D" | "7D" | "30D";

export const SOURCE_WEIGHT: Record<Grade, number> = { A: 1.0, B: 0.85, C: 0.0 };
export const RELATION_WEIGHT: Record<Relation, number> = { DIRECT: 1.0, INFERRED: 0.4 };

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function stanceVote(stance: Stance, resolvedDirection?: "BULLISH" | "BEARISH" | null): number {
  switch (stance) {
    case "BULLISH": return 1;
    case "BEARISH": return -1;
    case "MIXED":
      return resolvedDirection === "BULLISH" ? 0.25 : resolvedDirection === "BEARISH" ? -0.25 : 0;
    case "NEUTRAL":
    case "UNCLEAR":
    default:
      return 0;
  }
}

// Exponential decay; half-life widens with the window so 30D stays informative but 1D is punchy.
export function freshnessDecay(window: Window, ageHours: number): number {
  const halfLifeHours = window === "1D" ? 18 : window === "7D" ? 96 : 360;
  return Math.pow(0.5, Math.max(0, ageHours) / halfLifeHours);
}

export type LinkContribution = {
  stance: Stance;
  grade: Grade;
  relation: Relation;
  statementStrength: number;
  confidence: number;
  ageHours: number;
  resolvedDirection?: "BULLISH" | "BEARISH" | null;
};

export function linkScore(c: LinkContribution, window: Window): number {
  const sw = SOURCE_WEIGHT[c.grade];
  if (sw === 0) return 0; // grade C is discovery-only, never enters ranking
  return (
    stanceVote(c.stance, c.resolvedDirection) *
    sw *
    RELATION_WEIGHT[c.relation] *
    clamp(c.statementStrength, 0.5, 1.0) *
    clamp(c.confidence, 0.5, 1.0) *
    freshnessDecay(window, c.ageHours)
  );
}

// One person's net contribution for a stock in a window: sum their (already 24h-collapsed) links,
// then clamp to [-1, +1] so a single loud person cannot dominate the tape.
export function personContribution(links: LinkContribution[], window: Window): number {
  return clamp(links.reduce((sum, l) => sum + linkScore(l, window), 0), -1, 1);
}
