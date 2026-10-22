import { readFileSync, existsSync } from "node:fs";
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
async function main() {
  const { prisma } = await import("../../lib/prisma");

  const totalPairs = await prisma.fxPair.count();
  const activePairs = await prisma.fxPair.count({ where: { active: true } });
  const inactivePairs = totalPairs - activePairs;
  console.log("EXISTING_FX_PAIRS:", totalPairs, "ACTIVE:", activePairs, "INACTIVE:", inactivePairs);

  const quoteByProvider = await prisma.fxLatestQuote.groupBy({ by: ["source"], _count: true });
  console.log("fx_latest_quotes by source:", quoteByProvider);

  const aliasByProvider = await prisma.fxPairAlias.groupBy({ by: ["provider"], _count: true });
  console.log("fx_pair_aliases by provider:", aliasByProvider);

  // Pairs with a Yahoo-family alias (candidate direct pairs)
  const yahooAliases = await prisma.fxPairAlias.findMany({
    where: { provider: { in: ["YAHOO_CHART", "YAHOO-FINANCE2", "YAHOO"] } },
    select: { pairSymbol: true, provider: true, providerSymbol: true },
  });
  const pairsWithYahooAlias = new Set(yahooAliases.map((a) => a.pairSymbol));
  console.log("pairs with ANY yahoo-family alias:", pairsWithYahooAlias.size);

  // Pairs whose ONLY latest-quote source is DERIVED_CROSS_RATE (no direct provider quote at all)
  const derivedOnlyQuotes = await prisma.fxLatestQuote.findMany({ where: { source: "DERIVED_CROSS_RATE" }, select: { pairSymbol: true } });
  const derivedOnlySet = new Set(derivedOnlyQuotes.map((d) => d.pairSymbol));
  console.log("pairs with a DERIVED_CROSS_RATE latest quote:", derivedOnlySet.size);

  const allPairs = await prisma.fxPair.findMany({ select: { symbol: true, baseCurrency: true, quoteCurrency: true, active: true, providerSymbol: true } });
  let directCandidate = 0, derivedOnly = 0, unknown = 0;
  const directList: string[] = [];
  const derivedList: string[] = [];
  const unknownList: string[] = [];
  for (const p of allPairs) {
    const hasYahoo = pairsWithYahooAlias.has(p.symbol);
    const isDerivedOnly = derivedOnlySet.has(p.symbol) && !hasYahoo;
    if (hasYahoo) { directCandidate++; directList.push(p.symbol); }
    else if (isDerivedOnly) { derivedOnly++; derivedList.push(p.symbol); }
    else { unknown++; unknownList.push(p.symbol); }
  }
  console.log("DIRECT_PROVIDER_CANDIDATE (has yahoo-family alias):", directCandidate);
  console.log("DERIVED_CROSS_ONLY (no yahoo alias, has DERIVED_CROSS_RATE quote):", derivedOnly);
  console.log("UNKNOWN (no yahoo alias, no derived-cross quote either):", unknown);
  console.log("sample unknown (first 20):", unknownList.slice(0, 20));

  // Distinct currencies already present in fx_pairs
  const bases = new Set(allPairs.map((p) => p.baseCurrency));
  const quotes = new Set(allPairs.map((p) => p.quoteCurrency));
  console.log("existing DISTINCT base currencies:", bases.size, "quote currencies:", quotes.size, "union:", new Set([...bases, ...quotes]).size);

  await require("node:fs/promises").writeFile(
    ".scratch/fx-poc/legacy-classification.json",
    JSON.stringify({ directList, derivedList, unknownList, yahooAliases }, null, 2),
  );

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
