// Maps etfs.category / funds.category (a 187-value Morningstar-style free-text taxonomy, VERIFIED
// via a live GROUP BY this round) onto the 3 buckets 排行中心 needs (STOCK/BOND/COMMODITY), plus a
// 4th MIXED bucket for genuinely multi-asset categories (Allocation--*, Target-Date-*, balanced
// funds) that cannot be honestly forced into one of the three without misrepresenting them — the
// user asked for 股票/債券/商品 tabs; funds that are truly a mix of stocks+bonds are disclosed as
// MIXED rather than arbitrarily assigned to one side.
//
// 65.7% of ETFs (11,050/16,834) and 45.3% of funds (12,925/28,526) have category=NULL — this
// mapping cannot classify those; they fall through to UNCLASSIFIED and are simply absent from the
// category-filtered ranking tabs until a separate backfill effort gives them a category at all.

export type AssetCategoryBucket = "STOCK" | "BOND" | "COMMODITY" | "MIXED" | "UNCLASSIFIED";

const STOCK_CATEGORIES = new Set([
  "Large Blend", "Large Growth", "Large Value", "Small Blend", "Small Growth", "Small Value",
  "Mid-Cap Growth", "Mid-Cap Value", "Mid-Cap Blend", "Diversified Emerging Mkts",
  "Foreign Large Blend", "Foreign Large Growth", "Foreign Large Value", "Foreign Small/Mid Blend",
  "Foreign Small/Mid Growth", "Foreign Small/Mid Value", "Technology", "Health", "Financial",
  "Industrials", "Utilities", "Communications", "Consumer Cyclical", "Consumer Defensive",
  "Natural Resources", "Equity Energy", "Equity Precious Metals", "Equity Hedged",
  "Equity Market Neutral", "Equity Digital Assets", "World Large-Stock Blend",
  "World Large-Stock Growth", "World Large-Stock Value", "Global Large-Stock Blend",
  "Global Large-Stock Growth", "Global Large-Stock Value", "Global Small/Mid Stock",
  "World Small/Mid Stock", "Trading--Leveraged Equity", "Trading--Inverse Equity",
  "Long-Short Equity", "Focused Region", "Europe Stock", "Japan Stock", "India Equity",
  "China Region", "Greater China Region", "Pacific/Asia ex-Japan Stk", "Real Estate",
  "Global Real Estate", "Infrastructure", "Preferred Stock", "Energy Limited Partnership",
  "Miscellaneous Sector", "Digital Assets",
  "股票型", "國內股票開放型一般股票型", "國內股票開放型科技類", "國內股票開放型指數型",
  "國內股票開放型中小型", "國內投資股票型", "股票債券平衡型一般股票型", "國內股票開放型中概股型",
  "國內股票開放型上櫃股票型", "股票債券平衡型價值型股票型", "國內投資主動式交易所交易基金_股票型",
  "國內股票開放型價值型", "跨國投資股票型", "跨國投資指數股票型_股票型", "跨國投資主動式交易所交易基金_股票型",
  "跨國投資組合型_股票型", "其他股票", "Equity",
]);

const BOND_CATEGORIES = new Set([
  "High Yield Bond", "Intermediate Core-Plus Bond", "Intermediate Core Bond", "Short-Term Bond",
  "Ultrashort Bond", "Multisector Bond", "Muni National Interm", "Muni National Short",
  "Muni National Long", "Muni Single State Long", "Muni Single State Short", "Muni Single State Interm",
  "Muni California Long", "Muni California Intermediate", "Muni New York Long",
  "Muni New York Intermediate", "Muni Massachusetts", "Muni New Jersey", "Muni Ohio",
  "Muni Pennsylvania", "Muni Minnesota", "Muni Target Maturity", "Emerging Markets Bond",
  "Emerging-Markets Local-Currency Bond", "Bank Loan", "Inflation-Protected Bond",
  "Short-Term Inflation-Protected Bond", "Corporate Bond", "Nontraditional Bond", "World Bond",
  "World Bond-USD Hedged", "Global Bond", "Global Bond-USD Hedged", "Long-Term Bond",
  "Long Government", "Short Government", "Intermediate Government", "High Yield Muni",
  "Target Maturity", "Securitized Bond - Focused", "Securitized Bond - Diversified",
  "Government Mortgage-Backed Bond", "Miscellaneous Fixed Income", "Convertibles",
  "Trading--Inverse Debt", "Trading--Leveraged Debt", "Money Market-Taxable", "Prime Money Market",
  "固定收益型", "貨幣市場型", "跨國投資固定收益一般債券型", "跨國投資指數股票型_債券型",
  "跨國投資主動式交易所交易基金_債券型", "環球新興市場債券", "環球高收益債券", "美元高收益債券",
  "歐元多元化債券",
]);

const COMMODITY_CATEGORIES = new Set([
  "Commodities Broad Basket", "Commodities Focused", "Trading--Leveraged Commodities",
  "Trading--Inverse Commodities", "Systematic Trend", "Macro Trading",
]);

const MIXED_CATEGORIES = new Set([
  "Allocation--50% to 70% Equity", "Allocation--15% to 30% Equity", "Allocation--30% to 50% Equity",
  "Allocation--70% to 85% Equity", "Allocation--85%+ Equity", "Moderate Allocation",
  "Moderately Conservative Allocation", "Aggressive Allocation", "Conservative Allocation",
  "Moderately Aggressive Allocation", "Tactical Allocation", "Global Moderate Allocation",
  "Global Moderately Conservative Allocation", "Global Moderately Aggressive Allocation",
  "Global Conservative Allocation", "Global Aggressive Allocation", "Miscellaneous Allocation",
  "Target-Date 2000-2010", "Target-Date 2015", "Target-Date 2020", "Target-Date 2025",
  "Target-Date 2030", "Target-Date 2035", "Target-Date 2040", "Target-Date 2045",
  "Target-Date 2050", "Target-Date 2055", "Target-Date 2060", "Target-Date 2060+",
  "Target-Date 2065", "Target-Date 2065+", "Target-Date 2070+", "Target-Date Retirement",
  "Multistrategy", "Multi-Asset Overlay", "Event Driven", "Relative Value Arbitrage",
  "Options Trading", "Defined Outcome", "Derivative Income", "Trading--Miscellaneous",
  "Miscellaneous Region", "Miscellaneous Allocation",
  "跨國投資多重資產型", "平衡型(混合型)", "跨國投資組合型_平衡型", "跨國投資平衡型",
  "國內投資平衡型", "Single Currency",
  "國內投資主動式交易所交易基金之連結基金",
]);

export function classifyCategory(category: string | null | undefined): AssetCategoryBucket {
  if (!category) return "UNCLASSIFIED";
  if (STOCK_CATEGORIES.has(category)) return "STOCK";
  if (BOND_CATEGORIES.has(category)) return "BOND";
  if (COMMODITY_CATEGORIES.has(category)) return "COMMODITY";
  if (MIXED_CATEGORIES.has(category)) return "MIXED";
  return "UNCLASSIFIED"; // an unmapped category value shows up here rather than being guessed into a bucket
}

/** For building a SQL `category = ANY($n::text[])` filter — the inverse of classifyCategory,
 * exposed as arrays since the ranking API filters at the SQL level (for correct LIMIT/OFFSET
 * pagination) rather than filtering already-paginated rows in JS. */
export function categoriesForBucket(bucket: "STOCK" | "BOND" | "COMMODITY" | "MIXED"): string[] {
  return Array.from(
    bucket === "STOCK" ? STOCK_CATEGORIES : bucket === "BOND" ? BOND_CATEGORIES : bucket === "COMMODITY" ? COMMODITY_CATEGORIES : MIXED_CATEGORIES,
  );
}
