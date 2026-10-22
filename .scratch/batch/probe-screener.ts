import { screenerPage } from "../../lib/yahoo/productSession";

(async () => {
  const stats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  const base = await screenerPage("ETF", [{ operator: "GT", operands: ["fundnetassets", 0] }], 0, 1, "fundnetassets", stats);
  console.log("ETF total (no shard):", base.total);
  const exchanges = ["NYSEArca", "LSE", "NasdaqGM", "Cboe US", "Tokyo", "HKSE", "TWSE", "TPEx", "Cboe UK", "SES", "Nasdaq GIDS", "Aquis AQSE", "IOB", "NYSE"];
  for (const ex of exchanges) {
    const r = await screenerPage("ETF", [{ operator: "EQ", operands: ["exchange", ex] }], 0, 1, "fundnetassets", stats);
    console.log(ex, "->", r.total, "http", r.http);
  }
  // test region operand too
  for (const reg of ["us", "gb", "jp", "hk", "tw"]) {
    const r = await screenerPage("ETF", [{ operator: "EQ", operands: ["region", reg] }], 0, 1, "fundnetassets", stats);
    console.log("region", reg, "->", r.total, "http", r.http);
  }
  console.log("stats", JSON.stringify(stats));
})();
