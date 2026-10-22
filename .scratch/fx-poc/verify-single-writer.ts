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
  const derivedCount = await prisma.fxLatestQuote.count({ where: { source: "DERIVED_CROSS_RATE" } });
  console.log("DERIVED_CROSS_RATE quotes still present:", derivedCount, "(should be 162, unchanged)");

  const bySource = await prisma.fxLatestQuote.groupBy({ by: ["source"], _count: true });
  console.log("fx_latest_quotes by source:", bySource);

  // Anything written in the last 5 minutes NOT from this session's own scripts (source=YAHOO_SPARK is
  // ours; YAHOO_CHART could be either ours [updateFxHistory quote-side never sets it directly since
  // that path only writes fx_candles+coverage, quotes come from spark] or legacy).
  const recentChart = await prisma.fxLatestQuote.findMany({
    where: { source: "YAHOO_CHART", ingestedAt: { gte: new Date(Date.now() - 5 * 60_000) } },
    select: { pairSymbol: true, ingestedAt: true, quotedAt: true },
    orderBy: { ingestedAt: "desc" },
    take: 10,
  });
  console.log("fx_latest_quotes source=YAHOO_CHART touched in last 5 min (should be none/empty if no legacy writer active):", recentChart);

  const totalPairs = await prisma.fxPair.count();
  console.log("total fx_pairs (should be 552, unchanged from activation):", totalPairs);
  const totalCandles = await prisma.fxCandle.count();
  console.log("total fx_candles (should be >= 12.9M + new backfill rows, never less):", totalCandles);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
