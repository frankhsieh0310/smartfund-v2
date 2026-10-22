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
  const { prisma } = await import("../../lib/prisma");

  let cursor: string | null = null;
  let totalRequested = 0, totalResolved = 0, totalUpdated = 0, totalStale = 0, totalNoNew = 0, totalFailed = 0;
  let requestCount = 0;
  const failedSamples: Array<{ symbol: string; reason: string }> = [];
  for (;;) {
    const r = await updateFxQuotes(cursor, 20); // symbols=undefined -> full validated universe
    requestCount++;
    totalRequested += r.requestedPairs;
    totalResolved += r.resolvedPairs;
    totalUpdated += r.updatedPairs;
    totalStale += r.staleSkipped;
    totalNoNew += r.noNewData;
    totalFailed += r.failedPairs.length;
    failedSamples.push(...r.failedPairs.slice(0, 3));
    cursor = r.lastSymbol;
    if (r.wrapped) break;
  }
  console.log("FULL_UNIVERSE_QUOTE_TEST", { requestCount, totalRequested, totalResolved, totalUpdated, totalStale, totalNoNew, totalFailed, failedSamples: failedSamples.slice(0, 15) });

  // History categorization (Step 9) — no full backfill, just count how many of the 390 valid pairs
  // already have candles vs need an initial backfill.
  const { getActiveYahooDirectPairSymbols } = await import("../../lib/cloud-ingestion/fxUniverse");
  const universe = await getActiveYahooDirectPairSymbols();
  const withHistory = await prisma.fxCandle.groupBy({ by: ["pairSymbol"], where: { pairSymbol: { in: universe }, interval: "1d", source: "YAHOO_CHART" }, _count: true });
  const withHistorySet = new Set(withHistory.map((r) => r.pairSymbol));
  const needsBackfill = universe.filter((s) => !withHistorySet.has(s));
  console.log("HISTORY_EXISTING (has >=1 daily candle already):", withHistorySet.size);
  console.log("HISTORY_NEEDS_INITIAL_BACKFILL (none yet):", needsBackfill.length, needsBackfill);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
