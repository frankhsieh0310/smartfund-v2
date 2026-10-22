import { screenerPage, sleep } from "../../lib/yahoo/productSession";

const regions = [
  "us","gb","jp","hk","tw","cn","kr","au","ca","de","fr","it","es","se","sg",
  "ie","lu","ch","nl","be","at","dk","no","fi","pt","gr","pl","cz","hu","nz",
  "in","br","mx","za","il","tr","kw","sa","qa","ae","th","my","id","ph","vn",
];

(async () => {
  const stats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  let sum = 0;
  const nonzero: Record<string, number> = {};
  for (const reg of regions) {
    const r = await screenerPage("ETF", [{ operator: "EQ", operands: ["region", reg] }], 0, 1, "fundnetassets", stats);
    if (r.total > 0) { nonzero[reg] = r.total; sum += r.total; }
    await sleep(250);
  }
  console.log(JSON.stringify(nonzero, null, 1));
  console.log("SUM:", sum);
})();
