import { screenerPage, sleep } from "../../lib/yahoo/productSession";

(async () => {
  const stats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  const base = await screenerPage("MUTUALFUND", [{ operator: "GT", operands: ["fundnetassets", 0] }], 0, 1, "fundnetassets", stats);
  console.log("MF total (no filter):", base.total);
  const us = await screenerPage("MUTUALFUND", [{ operator: "GT", operands: ["fundnetassets", 0] }, { operator: "EQ", operands: ["region", "us"] }], 0, 1, "fundnetassets", stats);
  console.log("MF total (region=us):", us.total);
  await sleep(300);
  // sample raw quotes to see if region-tagging is meaningful for mutual funds
})();
