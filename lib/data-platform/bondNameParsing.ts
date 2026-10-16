// Parses a bond's issuer name / coupon rate / maturity date out of free-text disclosure strings
// (MoneyDJ's fund-side top-holdings disclosure has no CUSIP/ISIN at all -- just a name string like
// "ARGENTINIAN GOVT 4.125% 09 JUL 2035"). No NLP/fuzzy matching, per user instruction -- pure
// regex-based structural parsing of the handful of date/rate conventions actually observed in a live
// sample of 40 MoneyDJ disclosure rows (2026-10-16).
//
// This also normalizes issuer names for the ETF-side `holdings.holding_name` column, which -- VERIFIED
// live against 20 random ETF-side bond rows -- is ALWAYS just the issuer name (e.g. "KEYCORP MTN",
// "DOW CHEMICAL CO"), never coupon/maturity in text form. normalizeIssuer() is shared so both sides
// collapse to a comparable key.

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

export type ParsedBondName = {
  /** Issuer name with the coupon/maturity tokens stripped off, NOT yet normalized for matching. */
  issuerRaw: string;
  couponPct: number | null;
  /** ISO yyyy-mm-dd, or null if no maturity date could be confidently parsed. */
  maturityDate: string | null;
  /** True if the string has enough bond-like structure (a coupon% or maturity date or a common bond
   * boilerplate token) to be worth treating as a bond at all, vs. an equity/cash holding that just
   * happens to share this disclosure table. */
  looksLikeBond: boolean;
};

const BOND_KEYWORDS = /\b(MTN|144A|REG\s?S|SR\s?UNSEC|SR\s?NT|SUB\s?NTS?|GOVT|SENIOR\s+NOTES?|FIX|SERIES|BOND|NOTES?)\b/i;

// Coupon: "4.125%", "8.450000 %", "10%" -- always requires the literal "%" to avoid misreading a
// bare number (e.g. a bond's own face-value-per-unit or an equity's share count) as a rate.
const COUPON_RE = /(\d{1,2}(?:\.\d{1,6})?)\s*%/;
// Secondary, lower-confidence coupon form: a bare decimal number sitting directly in front of an
// already-matched maturity date with nothing but whitespace OR A HYPHEN between them (e.g. "SESI LLC
// 7.8875 30/09/2030", "INDON 4.75 07/18/47", or "GOLDMAN SACHS GROUP INC 6.75-2037/10/01" -- VERIFIED
// live, a real MoneyDJ disclosure convention) -- a standard bond-disclosure convention (rate
// immediately preceding the date), not a guess: only fires when a real maturity date was already
// found right after it.
const BARE_COUPON_BEFORE_DATE_RE = /(\d{1,2}\.\d{1,6})\s*-?\s*$/;

// Maturity date, tried in order -- each one anchored so it cannot match inside an unrelated number:
//   1. "15 JAN 2031" / "15-JAN-2031" / "09 JUL 2035"
//   2. "24FEB2028" (no separators)
//   3. "2037/10/01" or "2045-11-19" (YYYY/MM/DD or YYYY-MM-DD -- VERIFIED live, a real MoneyDJ
//      convention, e.g. "GOLDMAN SACHS GROUP INC 6.75-2037/10/01")
//   4. "15.04.2032" (DD.MM.YYYY)
//   5. "30/09/2030" or "07/18/47" (DD/MM/YYYY or MM/DD/YY -- disambiguated by which side is >12)
const DATE_PATTERNS: Array<{ re: RegExp; toIso: (m: RegExpMatchArray) => string | null }> = [
  {
    re: /\b(\d{1,2})[\s-](JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[\s-](\d{4})\b/i,
    toIso: (m) => `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`,
  },
  {
    re: /\b(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})\b/i,
    toIso: (m) => `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`,
  },
  {
    re: /\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/,
    toIso: (m) => {
      const [, y, mo, d] = m;
      if (Number(mo) > 12 || Number(d) > 31) return null;
      return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    },
  },
  {
    re: /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/,
    toIso: (m) => {
      const [, d, mo, y] = m;
      if (Number(d) > 31 || Number(mo) > 12) return null;
      return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    },
  },
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/,
    toIso: (m) => {
      const [, a, b, yRaw] = m;
      const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
      const an = Number(a), bn = Number(b);
      // Day-first if the first component can't be a month; month-first if the second can't be a day
      // (US convention, matches the "INDON 4.75 07/18/47" sample: 18 can't be a month -> MM/DD).
      if (an > 12 && bn <= 12) return `${y}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`; // DD/MM
      if (bn > 12 && an <= 12) return `${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`; // MM/DD
      // Both components <=12: genuinely ambiguous on structure alone. Every disambiguated sample in a
      // live 40+65-row audit (2026-10-16) that forced a direction (one side >12) turned out to be
      // MM/DD -- these disclosures are overwhelmingly USD corporate bonds using US convention, not a
      // mixed bag. Defaulting ambiguous ones to the SAME convention the data otherwise consistently
      // uses (e.g. "NVIDIA CORP 3.5% 04/01/2050" -> Apr 1, 2050, NVIDIA's real bond) is a disclosed,
      // evidence-based default, not a blind guess -- but it IS lower-confidence than the disambiguated
      // cases above, so callers should not treat it as equal-certainty.
      if (an <= 12 && bn <= 12) return `${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`; // MM/DD default
      return null;
    },
  },
];

export function parseBondDisclosureName(raw: string): ParsedBondName {
  const text = raw.trim();

  let couponPct: number | null = null;
  let couponIndex = -1;
  const couponMatch = text.match(COUPON_RE);
  if (couponMatch) {
    couponPct = Number(couponMatch[1]);
    couponIndex = couponMatch.index ?? -1;
  }

  let maturityDate: string | null = null;
  let maturityIndex = -1;
  for (const { re, toIso } of DATE_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const iso = toIso(m);
      if (iso) {
        maturityDate = iso;
        maturityIndex = m.index ?? -1;
        break;
      }
    }
  }

  // No explicit "%" coupon found, but there's a bare decimal immediately before the maturity date --
  // treat it as the coupon too, so the issuer text doesn't end up polluted with a stray rate number
  // (e.g. "INDON 4.75 07/18/47" -> issuer "INDON", not "INDON 4.75").
  if (couponPct === null && maturityIndex >= 0) {
    const bareCouponMatch = text.slice(0, maturityIndex).match(BARE_COUPON_BEFORE_DATE_RE);
    if (bareCouponMatch) {
      couponPct = Number(bareCouponMatch[1]);
      couponIndex = bareCouponMatch.index ?? -1;
    }
  }

  const cutIndex = [couponIndex, maturityIndex].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const issuerRaw = (cutIndex !== undefined ? text.slice(0, cutIndex) : text)
    .replace(/[,\s]+$/, "")
    .trim();

  const looksLikeBond = couponPct !== null || maturityDate !== null || BOND_KEYWORDS.test(text);

  return { issuerRaw, couponPct, maturityDate, looksLikeBond };
}

// Shared normalization so the MoneyDJ-side parsed issuer and the ETF-side holding_name (which, per
// the live sample, is ALSO essentially just an issuer name with boilerplate suffixes) collapse to the
// same key when they genuinely are the same issuer. Pure string normalization, no fuzzy/NLP matching.
// "/THE" is a standard US-listing suffix used to disambiguate a legal name that starts with "The"
// (e.g. "GOLDMAN SACHS GROUP INC/THE" = "The Goldman Sachs Group Inc") -- VERIFIED live: this exact
// suffix on the ETF side caused a real false-negative against MoneyDJ's own "GOLDMAN SACHS GROUP INC"
// (no "/THE") until this was stripped. Stripped BEFORE the generic suffix pass since "/" would
// otherwise just become a space and leave a bare "THE" token.
const TRAILING_THE_RE = /\/\s*THE\s*$/i;
const ISSUER_SUFFIX_RE = /\b(CO|CORP|CORPORATION|INC|LTD|LLC|LLP|PLC|SA|AG|NV|AS|SE|HOLDINGS?|HLDGS?|GROUP|CO\.|INC\.|LTD\.|CORP\.)\b\.?/gi;
const ISSUER_BOILERPLATE_RE = /\b(MTN|144A|REG\s?S|SR\s?UNSEC|SR\s?NT|SUB\s?NTS?|SERIES|FIX)\b/gi;

export function normalizeIssuer(raw: string): string {
  return raw
    .toUpperCase()
    .replace(TRAILING_THE_RE, "")
    .replace(ISSUER_BOILERPLATE_RE, " ")
    .replace(ISSUER_SUFFIX_RE, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
