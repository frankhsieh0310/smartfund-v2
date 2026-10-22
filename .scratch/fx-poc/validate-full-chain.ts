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
  const { updateFxQuotes } = await import("../../lib/cron/fxUpdate");
  const { updateDerivedFxQuotes } = await import("../../lib/cron/fxDerivedUpdate");
  const { getActiveYahooDirectPairSymbols } = await import("../../lib/cloud-ingestion/fxUniverse");
  const { prisma } = await import("../../lib/prisma");

  const directCount = (await getActiveYahooDirectPairSymbols()).length;
  console.log("YAHOO_DIRECT_PAIRS:", directCount);

  let cursor: string | null = null, requests = 0, requested = 0, updated = 0, failed = 0, wrapped = false;
  const started = Date.now();
  while (!wrapped) {
    const r = await updateFxQuotes(cursor, 20);
    requests++; requested += r.requestedPairs; updated += r.updatedPairs; failed += r.failedPairs.length;
    cursor = r.lastSymbol; wrapped = r.wrapped;
  }
  console.log("FULL QUOTE SWEEP:", { requests, requested, updated, failed, ms: Date.now() - started });

  const dstarted = Date.now();
  const d = await updateDerivedFxQuotes();
  console.log("CHAINED DERIVED UPDATE:", { ...d, ms: Date.now() - dstarted });

  const totalPairs = await prisma.fxPair.count();
  console.log("total fx_pairs:", totalPairs);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
