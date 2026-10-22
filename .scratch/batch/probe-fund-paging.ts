import { screenerPage, sleep } from "../../lib/yahoo/productSession";

(async () => {
  const stats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  // how far can offset go on region=us alone?
  for (const off of [0, 2000, 5000, 8000, 9500, 9975, 10000, 12000]) {
    const r = await screenerPage("MUTUALFUND", [{ operator: "GT", operands: ["fundnetassets", 0] }, { operator: "EQ", operands: ["region", "us"] }], off, 5, "fundnetassets", stats);
    console.log("offset", off, "-> got", r.symbols.length, "symbols, http", r.http, "sample", r.symbols[0]);
    await sleep(250);
  }
  // retry the zero/low categories with alt spellings
  const alt: Record<string, string> = {
    "World Stock": "World Large Stock",
    "World Bond": "World Bond-USD Hedged",
    "Precious Metals": "Equity Precious Metals",
    "Market Neutral": "Market Neutral (Absolute Return)",
    "Allocation--30% to 50% Equity": "Allocation–30% to 50% Equity",
  };
  for (const [orig, alt2] of Object.entries(alt)) {
    const r = await screenerPage("MUTUALFUND", [{ operator: "EQ", operands: ["categoryname", alt2] }, { operator: "EQ", operands: ["region", "us"] }], 0, 1, "fundnetassets", stats);
    console.log(orig, "alt=", JSON.stringify(alt2), "->", r.total);
    await sleep(200);
  }
})();
