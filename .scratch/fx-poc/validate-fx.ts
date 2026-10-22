// Targeted validation script for the FX Data Platform P0 (Step 17/20). Loads .env into
// process.env internally (never printed) so PrismaClient can connect the same way `next dev`
// would, then exercises seed -> quote -> history -> second-run-idempotency and prints only
// aggregate counts. Not part of the shipped app; delete after validation.
import { readFileSync, existsSync } from "node:fs";

for (const file of [".env", ".env.local"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function main() {
  const { seedFxUniverse } = await import("../../lib/cloud-ingestion/fxUniverse");
  const { updateFxQuotes, updateFxHistory } = await import("../../lib/cron/fxUpdate");
  const { prisma } = await import("../../lib/prisma");

  console.log("=== SEED ===");
  console.log(await seedFxUniverse());

  console.log("=== QUOTE (run 1) ===");
  const q1 = await updateFxQuotes(null, 19);
  console.log({ requestedPairs: q1.requestedPairs, resolvedPairs: q1.resolvedPairs, updatedPairs: q1.updatedPairs, staleSkipped: q1.staleSkipped, noNewData: q1.noNewData, failedPairs: q1.failedPairs });

  console.log("=== HISTORY (run 1) ===");
  const h1 = await updateFxHistory(null, 19);
  console.log({ requestedPairs: h1.requestedPairs, updatedPairs: h1.updatedPairs, rowsWritten: h1.rowsWritten, failedPairs: h1.failedPairs });

  const candleCountAfter1 = await prisma.fxCandle.count();
  console.log("fx_candles rowcount after run 1:", candleCountAfter1);

  console.log("=== QUOTE (run 2, idempotency check) ===");
  const q2 = await updateFxQuotes(null, 19);
  console.log({ requestedPairs: q2.requestedPairs, updatedPairs: q2.updatedPairs, staleSkipped: q2.staleSkipped, noNewData: q2.noNewData, failedPairs: q2.failedPairs });

  console.log("=== HISTORY (run 2, idempotency check) ===");
  const h2 = await updateFxHistory(null, 19);
  console.log({ requestedPairs: h2.requestedPairs, updatedPairs: h2.updatedPairs, rowsWritten: h2.rowsWritten, failedPairs: h2.failedPairs });

  const candleCountAfter2 = await prisma.fxCandle.count();
  console.log("fx_candles rowcount after run 2 (should be unchanged if idempotent):", candleCountAfter2);

  console.log("=== SPOT CHECK: targeted pairs ===");
  const targets = ["USDTWD", "EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCNY", "USDHKD", "USDSGD", "USDKRW"];
  for (const sym of targets) {
    const pair = await prisma.fxPair.findUnique({ where: { symbol: sym } });
    const quote = await prisma.fxLatestQuote.findUnique({ where: { pairSymbol: sym } });
    const candleCount = await prisma.fxCandle.count({ where: { pairSymbol: sym } });
    const latestCandle = await prisma.fxCandle.findFirst({ where: { pairSymbol: sym }, orderBy: { openTime: "desc" } });
    console.log(sym, {
      pairExists: !!pair,
      providerSymbol: pair?.providerSymbol,
      latestQuoteMid: quote?.mid?.toString() ?? null,
      latestQuoteAt: quote?.quotedAt?.toISOString() ?? null,
      candleCount,
      latestCandleDate: latestCandle?.openTime.toISOString().slice(0, 10) ?? null,
    });
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error("VALIDATION_FAILED", e); process.exit(1); });
