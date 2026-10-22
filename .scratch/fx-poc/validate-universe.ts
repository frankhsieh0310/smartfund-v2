import { readFileSync, existsSync, writeFileSync } from "node:fs";
for (const file of [".env", ".env.local"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1]; let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { prisma } = await import("../../lib/prisma");
  const { fetchYahooFxSpark } = await import("../../lib/services/dataProviders/yahoo/yahooClient");

  // One alias per pair, preferring YAHOO_CHART (present for all 528 legacy pairs).
  const aliases = await prisma.fxPairAlias.findMany({
    where: { provider: { in: ["YAHOO_CHART", "YAHOO", "YAHOO-FINANCE2"] } },
    orderBy: { provider: "desc" }, // YAHOO_CHART > YAHOO-FINANCE2 > YAHOO alphabetically desc puts CHART... check below
    select: { pairSymbol: true, provider: true, providerSymbol: true },
  });
  const byPair = new Map<string, { provider: string; providerSymbol: string }>();
  // Explicit preference order (not relying on sort): YAHOO_CHART first, else YAHOO, else YAHOO-FINANCE2
  const preferOrder = ["YAHOO_CHART", "YAHOO", "YAHOO-FINANCE2"];
  for (const pref of preferOrder) {
    for (const a of aliases) {
      if (a.provider === pref && !byPair.has(a.pairSymbol)) byPair.set(a.pairSymbol, { provider: a.provider, providerSymbol: a.providerSymbol });
    }
  }
  const entries = [...byPair.entries()]; // [pairSymbol, {provider, providerSymbol}]
  console.log("Total pairs to validate:", entries.length);

  const batches = chunk(entries, 20);
  console.log("Batches:", batches.length);

  const results: Record<string, { requestedSymbol: string; ok: boolean; canonicalSymbol: string | null; currency: string | null; price: number | null; time: string | null }> = {};
  let batchNum = 0;
  for (const batch of batches) {
    batchNum++;
    const symbols = batch.map(([, a]) => a.providerSymbol);
    const spark = await fetchYahooFxSpark(symbols);
    for (const [pairSymbol, alias] of batch) {
      const r = spark.find((s) => s.requestedSymbol === alias.providerSymbol);
      results[pairSymbol] = {
        requestedSymbol: alias.providerSymbol,
        ok: !!r?.ok,
        canonicalSymbol: r?.canonicalSymbol ?? null,
        currency: r?.currency ?? null,
        price: r?.regularMarketPrice ?? null,
        time: r?.regularMarketTime ? r.regularMarketTime.toISOString() : null,
      };
    }
    if (batchNum % 5 === 0) console.log(`...batch ${batchNum}/${batches.length} done`);
    await sleep(400);
  }

  let valid = 0, aliasDiff = 0, invalid = 0, noData = 0;
  const invalidList: string[] = [], noDataList: string[] = [];
  for (const [pairSymbol, r] of Object.entries(results)) {
    if (r.canonicalSymbol == null && !r.ok) { noData++; noDataList.push(pairSymbol); continue; }
    if (!r.ok) { invalid++; invalidList.push(pairSymbol); continue; }
    if (r.canonicalSymbol && r.canonicalSymbol !== r.requestedSymbol) aliasDiff++;
    else valid++;
  }
  console.log("YAHOO_VALID (exact echo):", valid);
  console.log("YAHOO_ALIAS (ok but Yahoo canonicalized differently):", aliasDiff);
  console.log("YAHOO_INVALID (meta present, no usable price):", invalid, invalidList.slice(0, 30));
  console.log("NO_DATA (nothing back at all):", noData, noDataList.slice(0, 30));

  writeFileSync(".scratch/fx-poc/universe-validation.json", JSON.stringify(results, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
