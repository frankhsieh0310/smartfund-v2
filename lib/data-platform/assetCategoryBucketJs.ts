// JS-side mirror of app/api/rankings/performance/route.ts's etfCategoryFilter() SQL clause, for
// endpoints (like reverse-holdings) that classify an already-small, already-fetched result set in
// application code instead of inside a paginated SQL query. Keep this in sync with that file's
// regex patterns — do not invent a different rule here.
import { classifyCategory, type AssetCategoryBucket } from "./categoryClassification";

const LEVERAGE_INVERSE_CODE_SUFFIX = /(L|R)$/;
const BOND_NAME_PATTERN = /債/;
const COMMODITY_NAME_PATTERN = /原油|黃金|白銀|商品|石油|布蘭特|天然氣|農產品/;

/** ETF bucket: code-suffix for leverage/inverse, name-keyword for bond/commodity (category is
 * NULL for ~66% of ETFs, overwhelmingly so for the ZH/TW universe), category table otherwise. */
export function classifyEtfBucketJs(code: string, name: string, category: string | null): AssetCategoryBucket {
  if (LEVERAGE_INVERSE_CODE_SUFFIX.test(code)) return "LEVERAGE_INVERSE";
  if (classifyCategory(category) === "LEVERAGE_INVERSE") return "LEVERAGE_INVERSE";
  if (BOND_NAME_PATTERN.test(name)) return "BOND";
  if (COMMODITY_NAME_PATTERN.test(name)) return "COMMODITY";
  const byCategory = classifyCategory(category);
  if (byCategory === "BOND" || byCategory === "COMMODITY" || byCategory === "MIXED") return byCategory;
  return "STOCK";
}

/** FUND bucket: funds.category alone (same taxonomy as the ranking center's FUND filter —
 * no name-keyword fallback there, so none here either). */
export function classifyFundBucketJs(category: string | null): AssetCategoryBucket {
  return classifyCategory(category);
}
