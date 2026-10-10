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

// Task P: a PRICE_JUMP_REVIEW gets a second opinion from an INDEPENDENT source — Yahoo's own
// previous-session close (Spark meta.chartPreviousClose, or the prior daily bar) — before it's
// permanently held back. The DXJ scenario this round is the textbook case: DB's last known close was
// 180.55 (badly stale — the DB simply hadn't been updated in a while), today's new price is 60.71,
// which looks like a huge drop against the stale DB value; but Yahoo's OWN previous close was 60.677
// — the "jump" only exists relative to our own out-of-date record, not in reality. Reclassifying
// this DB_DISCONTINUITY (written, flagged for later review) rather than leaving it stuck as
// PRICE_JUMP_REVIEW (never written) is exactly what lets the DB catch back up instead of staying
// permanently wrong. If Yahoo's own data ALSO shows the same size of jump, there's no independent
// corroboration that this is just DB staleness — stays PRICE_JUMP_REVIEW, unwritten.
export type JumpReviewOutcome = "DB_DISCONTINUITY" | "PRICE_JUMP_REVIEW";

export function reviewPriceJump(newPrice: number, yahooPreviousClose: number | null): JumpReviewOutcome {
  if (yahooPreviousClose == null || yahooPreviousClose === 0) return "PRICE_JUMP_REVIEW"; // no independent corroboration available — stay conservative
  const changeFraction = Math.abs(newPrice - yahooPreviousClose) / yahooPreviousClose;
  return changeFraction <= PRICE_JUMP_THRESHOLD_FRACTION ? "DB_DISCONTINUITY" : "PRICE_JUMP_REVIEW";
}
