// Task Z Part B.2: unit-mismatch + jump guard for domestic fund NAV, mirroring the SHAPE of
// lib/market-close-sync/priceSanity.ts (not imported/modified — that file's threshold is a fixed
// 50% hardcoded const, and the user asked for a stricter 20% here, appropriate for a mutual fund's
// own NAV, which moves far less day-to-day than a stock/ETF price). A fund NAV jumping >20% in one
// day is almost always a data error (unit mix-up, a bad CSV row, or a genuine fund event like a
// split/distribution adjustment) rather than ordinary market movement, so it's held back rather than
// written, same "record-only, never silently accepted" philosophy as priceSanity.ts.

export type NavSanityResult = "UNIT_MISMATCH" | "JUMP_REVIEW" | null;

const UNIT_MISMATCH_RATIO_LOW = 95;
const UNIT_MISMATCH_RATIO_HIGH = 105;
const UNIT_MISMATCH_INVERSE_RATIO_LOW = 1 / UNIT_MISMATCH_RATIO_HIGH;
const UNIT_MISMATCH_INVERSE_RATIO_HIGH = 1 / UNIT_MISMATCH_RATIO_LOW;
const JUMP_THRESHOLD_FRACTION = 0.2;

export function checkNavSanity(newNav: number, lastKnownNav: number | null): NavSanityResult {
  if (lastKnownNav == null || lastKnownNav === 0) return null; // nothing to compare against — e.g. a fund with no prior NAV yet
  const ratio = newNav / lastKnownNav;
  if (
    (ratio >= UNIT_MISMATCH_RATIO_LOW && ratio <= UNIT_MISMATCH_RATIO_HIGH) ||
    (ratio >= UNIT_MISMATCH_INVERSE_RATIO_LOW && ratio <= UNIT_MISMATCH_INVERSE_RATIO_HIGH)
  ) {
    return "UNIT_MISMATCH";
  }
  const changeFraction = Math.abs(newNav - lastKnownNav) / lastKnownNav;
  if (changeFraction > JUMP_THRESHOLD_FRACTION) return "JUMP_REVIEW";
  return null;
}
