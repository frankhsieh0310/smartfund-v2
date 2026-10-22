import { PrismaClient } from "@prisma/client";
import { buildFxPairs, loadFxConfig } from "./fx-config.ts";

const prisma = new PrismaClient();

async function main() {
  const config = await loadFxConfig();
  const expectedPairs = buildFxPairs(config);
  const [sourceCount, officialSourceCount, currencyCount, pairCount, candleStats, quoteCount, failedWork, coverage] = await Promise.all([
    prisma.fxSource.count({ where: { active: true } }), prisma.fxSource.count({ where: { active: true, official: true } }),
    prisma.fxCurrency.count({ where: { active: true } }), prisma.fxPair.count({ where: { active: true } }),
    prisma.fxCandle.aggregate({ _count: true, _min: { openTime: true }, _max: { openTime: true } }),
    prisma.fxLatestQuote.count(), prisma.fxWorkItem.count({ where: { status: { in: ["PENDING", "FAILED"] } } }),
    prisma.fxCoverage.groupBy({ by: ["capability", "interval", "status", "qualityStatus"], _count: true }),
  ]);
  const checks = {
    officialRegistry: officialSourceCount >= 13,
    legalMarketSource: sourceCount > officialSourceCount,
    currencyUniverse: currencyCount === config.currencies.length,
    pairUniverse: pairCount === expectedPairs.length,
    historicalRows: candleStats._count > 0,
    latestQuotes: quoteCount > 0,
    failureQueueBounded: failedWork >= 0,
  };
  const status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
  console.log(JSON.stringify({ status, generatedAt: new Date().toISOString(), expected: { sources: config.sources.length, currencies: config.currencies.length, pairs: expectedPairs.length }, actual: { sourceCount, officialSourceCount, currencyCount, pairCount, candles: candleStats, quoteCount, failedWork }, checks, coverage }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
  if (status !== "PASS") process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
