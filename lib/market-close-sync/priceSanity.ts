// Task O: a resolved price (BAR or QUOTE_FINAL) is sanity-checked against the ETF's own last known
// DB close BEFORE it's allowed to count as NEW/CHANGED/SAME/DB_NEWER. Two failure modes, both
// record-only — shadow mode never writes price tables regardless, so "不寫入" is already satisfied
// structurally; what this adds is keeping these two cases OUT of the normal classification buckets
// so they don't silently inflate NEW/CHANGED counts with data that's actually suspect:
//
//   UNIT_MISMATCH: the new price is ~100x (or ~1/100x) the last known close — the classic GBX
//   (pence) vs GBP (pounds) mix-up already confirmed live in Task N for several UK .XC/.IL symbols
//   (e.g. IFFFL.XC: 72.4 vs 7240, exactly a 100x ratio). Checked symmetrically (works whichever
//   direction the mismatch runs) via two multiplicative bands, not a hardcoded "100", so it also
//   catches realistic real-world rounding/precision drift around the exact centum.
//
//   PRICE_JUMP_REVIEW: anything else whose magnitude of change exceeds 50% — not necessarily wrong,
//   but far outside a single trading day's normal range for an ETF, so it's held for human review
//   rather than silently accepted as a genuine CHANGED.
//
// A normal day's move (even a volatile one, e.g. ±3-10%) must clear both checks untouched.

export type PriceSanityResult = "UNIT_MISMATCH" | "PRICE_JUMP_REVIEW" | null;

const UNIT_MISMATCH_RATIO_LOW = 95;
const UNIT_MISMATCH_RATIO_HIGH = 105;
const UNIT_MISMATCH_INVERSE_RATIO_LOW = 1 / UNIT_MISMATCH_RATIO_HIGH; // 0.00952...
const UNIT_MISMATCH_INVERSE_RATIO_HIGH = 1 / UNIT_MISMATCH_RATIO_LOW; // 0.01053...
const PRICE_JUMP_THRESHOLD_FRACTION = 0.5;

export function checkPriceSanity(newPrice: number, lastKnownClose: number | null): PriceSanityResult {
  if (lastKnownClose == null || lastKnownClose === 0) return null; // nothing to compare against — e.g. a genuinely new listing
  const ratio = newPrice / lastKnownClose;
  if (
    (ratio >= UNIT_MISMATCH_RATIO_LOW && ratio <= UNIT_MISMATCH_RATIO_HIGH) ||
    (ratio >= UNIT_MISMATCH_INVERSE_RATIO_LOW && ratio <= UNIT_MISMATCH_INVERSE_RATIO_HIGH)
  ) {
    return "UNIT_MISMATCH";
  }
  const changeFraction = Math.abs(newPrice - lastKnownClose) / lastKnownClose;
  if (changeFraction > PRICE_JUMP_THRESHOLD_FRACTION) return "PRICE_JUMP_REVIEW";
  return null;
}
