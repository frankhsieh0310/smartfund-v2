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
  const { activateFullYahooDirectUniverse, DISCOVERED_PAIRS } = await import("../../lib/cloud-ingestion/fxUniverse");
  const { fetchYahooFxSpark } = await import("../../lib/services/dataProviders/yahoo/yahooClient");
  const existing = JSON.parse(readFileSync(".scratch/fx-poc/universe-validation.json", "utf8")) as Record<string, { ok: boolean; canonicalSymbol: string | null }>;

  // The 24 discovered currencies aren't in fx_pairs yet, so activateFullYahooDirectUniverse will
  // create them first; validate their USD-cross symbols too so they get tagged VALID immediately
  // (already confirmed individually live — re-batch here in groups of 20 for the coverage record).
  const discoveredValidation: Record<string, { ok: boolean; canonicalSymbol: string | null }> = {};
  for (let i = 0; i < DISCOVERED_PAIRS.length; i += 20) {
    const slice = DISCOVERED_PAIRS.slice(i, i + 20);
    const symbols = slice.map((p) => `${p.base}${p.quote}=X`);
    const spark = await fetchYahooFxSpark(symbols);
    for (const p of slice) {
      const sym = `${p.base}${p.quote}=X`;
      const r = spark.find((s) => s.requestedSymbol === sym);
      discoveredValidation[`${p.base}${p.quote}`] = { ok: !!r?.ok, canonicalSymbol: r?.canonicalSymbol ?? null };
    }
  }
  console.log("discovered validation:", discoveredValidation);

  const combined = { ...existing, ...discoveredValidation };
  const result = await activateFullYahooDirectUniverse(combined);
  console.log("ACTIVATION RESULT:", result);

  const { prisma } = await import("../../lib/prisma");
  const totalPairs = await prisma.fxPair.count();
  const validCoverage = await prisma.fxCoverage.count({ where: { capability: "YAHOO_DIRECT", status: "VALID" } });
  const invalidCoverage = await prisma.fxCoverage.count({ where: { capability: "YAHOO_DIRECT", status: "INVALID" } });
  console.log("total fx_pairs now:", totalPairs, "YAHOO_DIRECT valid:", validCoverage, "invalid:", invalidCoverage);

  const { getActiveYahooDirectPairSymbols } = await import("../../lib/cloud-ingestion/fxUniverse");
  const activeUniverse = await getActiveYahooDirectPairSymbols();
  console.log("PRODUCTION SCOPE (active Yahoo-direct pairs):", activeUniverse.length);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
