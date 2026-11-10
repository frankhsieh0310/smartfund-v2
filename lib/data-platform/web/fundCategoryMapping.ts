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
// 2026-11-11（使用者核准，第6項根因修正）: 對照funds.category全部現有不重複值跑過這組mapping，
// 找出名稱明顯是股票/多重資產、卻因為regex沒收錄而落到「其他」的6種（共226筆）：
//   - World Small/Mid Stock / Europe Stock：舊的world(large|small)[- ]stock只配對得到「World
//     Small-Stock」這種字中間沒有"/Mid"的寫法，Morningstar實際常見寫法中間帶"/Mid"；Europe Stock
//     完全沒有對應的regex。
//   - China Region：Morningstar區域型股票分類，跟已經收錄的pacific/asia同一組，沒收錄純粹漏了。
//   - Consumer Defensive / Infrastructure：跟已經收錄的communications/consumer cyclical/energy等
//     同一組Morningstar產業型股票分類，名單沒列到。
// Commodities Broad Basket/Equity Precious Metals等商品型、Multistrategy/Options Trading等另類
// 投資策略型，這4個分類本身沒有對應bucket（跟ETF側categoryClassification.ts有獨立COMMODITY bucket
// 不同）——這裡沒有新增bucket，繼續誠實歸其他，不能亂塞進股票/債券/多重資產。
const EQUITY_PATTERNS = [
  /large (blend|growth|value)/i, /mid-cap (blend|growth|value)/i, /small (blend|growth|value)/i,
  /foreign (large|small)/i, /world (large|small)([-\/]\w+)?[- ]stock/i, /^europe stock$/i, /diversified emerging mkts/i,
  /pacific\/asia/i, /china region/i, /trading--leveraged equity/i,
  /^(communications|consumer cyclical|consumer defensive|energy$|equity energy|financial|health|industrials|infrastructure|natural resources|technology|utilities)$/i,
  /股票/,
];
const MULTI_ASSET_PATTERNS = [
  /^allocation--/i, /^target-date/i, /tactical allocation/i,
  /平衡型/, /股票債券平衡/, /多重資產/,
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
