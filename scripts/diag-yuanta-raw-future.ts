// Bounded diagnosis — one ticker (00739), raw FutureWeights rows in full, to find a contract-month/
// expiry field the adapter currently drops. No DB write, no adapter change yet.
const BASE = "https://www.yuantaetfs.com";

function extractNuxtState(html: string): any {
  const m = html.match(/<script>window\.__NUXT__=([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no nuxt state");
  return new Function(`return ${m[1]}`)();
}
function findWeightData(nuxtState: any): any {
  for (const block of nuxtState?.data ?? []) {
    if (block?.weightData?.FundWeights) return block.weightData;
  }
  throw new Error("no weightData");
}

async function main() {
  const r = await fetch(`${BASE}/product/detail/00739/ratio`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await r.text();
  const wd = findWeightData(extractNuxtState(html));
  console.log(JSON.stringify(wd.FundWeights.FutureWeights, null, 2));
}
main();
