import { screenerPage, sleep } from "../../lib/yahoo/productSession";

const CATS = [
  "Large Blend","Large Growth","Large Value","Mid-Cap Blend","Mid-Cap Growth","Mid-Cap Value",
  "Small Blend","Small Growth","Small Value","Foreign Large Blend","Foreign Large Growth","Foreign Large Value",
  "Foreign Small/Mid Blend","Diversified Emerging Mkts","World Stock","Global Real Estate","Real Estate",
  "Technology","Health","Financial","Natural Resources","Utilities","Communications","Consumer Cyclical",
  "Consumer Defensive","Industrials","Equity Energy","Precious Metals","Miscellaneous Sector",
  "Intermediate Core Bond","Intermediate Core-Plus Bond","Short-Term Bond","Long-Term Bond","Ultrashort Bond",
  "High Yield Bond","Multisector Bond","World Bond","Emerging Markets Bond","Bank Loan","Inflation-Protected Bond",
  "Muni National Long","Muni National Interm","Muni National Short","High Yield Muni","Muni Single State Long",
  "Allocation--30% to 50% Equity","Allocation--50% to 70% Equity","Allocation--70% to 85% Equity",
  "Allocation--85%+ Equity","Moderate Allocation","Conservative Allocation","Target-Date 2030","Target-Date 2040",
  "Target-Date 2050","Target-Date Retirement","World Allocation","Convertibles","Multialternative",
  "Long-Short Equity","Market Neutral","Commodities Broad Basket","Trading--Leveraged Equity",
];

(async () => {
  const stats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  let sum = 0;
  const totals: Record<string, number> = {};
  for (const cat of CATS) {
    const r = await screenerPage("MUTUALFUND", [
      { operator: "EQ", operands: ["categoryname", cat] },
      { operator: "EQ", operands: ["region", "us"] },
    ], 0, 1, "fundnetassets", stats);
    totals[cat] = r.total;
    sum += r.total;
    await sleep(200);
  }
  console.log(JSON.stringify(totals, null, 1));
  console.log("SUM:", sum, "num_categories:", CATS.length);
})();
