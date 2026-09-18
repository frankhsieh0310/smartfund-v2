// Deterministic SmartMatch main-category mapping over Yahoo's raw fund "group" text
// (funds.category — Morningstar categoryName for the Yahoo US mutual-fund pipeline, or the
// existing SITCA-style Chinese classification for Taiwan-market funds). The raw text is never
// altered or discarded: it is exposed as-is (fundSubcategory). This mapping only adds one coarse
// label on top of it (fundCategory) for Web/App search and filtering — it never re-derives a
// category from the fund's own name, and it never invents a subcategory Yahoo/SITCA didn't give.
export type FundMainCategory = "債券型基金" | "股票型基金" | "多重資產基金" | "其他";

const BOND_PATTERNS = [
  /bond/i, /\bmuni\b/i, /government/i, /bank loan/i, /convertible/i, /preferred stock/i,
  /固定收益/, /債券/,
];
const EQUITY_PATTERNS = [
  /large (blend|growth|value)/i, /mid-cap (blend|growth|value)/i, /small (blend|growth|value)/i,
  /foreign (large|small)/i, /world (large|small)[- ]stock/i, /diversified emerging mkts/i,
  /pacific\/asia/i, /trading--leveraged equity/i,
  /^(communications|consumer cyclical|energy$|equity energy|financial|health|industrials|natural resources|technology|utilities)$/i,
  /股票/,
];
const MULTI_ASSET_PATTERNS = [
  /^allocation--/i, /^target-date/i, /tactical allocation/i,
  /平衡型/, /股票債券平衡/,
];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * @param rawGroup the source's raw fund-group text (funds.category), unmodified.
 * @returns the SmartMatch main category, or "其他" when the raw text can't be reliably classified
 *   (including null/empty input) — never guessed from the fund's own name.
 */
export function mapFundMainCategory(rawGroup: string | null | undefined): FundMainCategory {
  const text = rawGroup?.trim();
  if (!text) return "其他";
  // Multi-asset first: a "balanced"/allocation category can legitimately contain both an equity
  // and a fixed-income word (e.g. "股票債券平衡型") — that combination means multi-asset, not bond.
  if (matchesAny(MULTI_ASSET_PATTERNS, text)) return "多重資產基金";
  if (matchesAny(BOND_PATTERNS, text)) return "債券型基金";
  if (matchesAny(EQUITY_PATTERNS, text)) return "股票型基金";
  return "其他";
}
