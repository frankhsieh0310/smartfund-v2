import { PrismaClient } from "@prisma/client";
import { buildFxPairs, loadFxConfig } from "./fx-config.ts";

const prisma = new PrismaClient();

async function main() {
  const config = await loadFxConfig();
  const pairs = buildFxPairs(config);
  for (const source of config.sources) {
    await prisma.fxSource.upsert({
      where: { id: source.id },
      create: { ...source, legalPublic: true },
      update: { ...source, legalPublic: true },
    });
  }
  for (const [code, name, isoNumeric, minorUnits, authorityId] of config.currencies) {
    await prisma.fxCurrency.upsert({
      where: { code }, create: { code, name, isoNumeric, minorUnits, authorityId },
      update: { name, isoNumeric, minorUnits, authorityId, active: true },
    });
  }
  for (let offset = 0; offset < pairs.length; offset += 100) {
    await prisma.$transaction(pairs.slice(offset, offset + 100).map((pair) => prisma.fxPair.upsert({
      where: { symbol: pair.symbol }, create: pair, update: { ...pair, active: true },
    })));
  }
  const intervalCapabilities = new Set(["HISTORICAL", "INTRADAY", "OHLCV", "VOLATILITY", "DERIVED_ANALYTICS", "TECHNICAL", "CHART_READY"]);
  const coverage = pairs.flatMap((pair) => config.capabilities.flatMap((capability) => {
    const intervals = intervalCapabilities.has(capability) ? config.intervals : [""];
    return intervals.map((interval) => ({ pairSymbol: pair.symbol, capability, interval, status: "MISSING", qualityStatus: "PENDING", details: { reason: "AWAITING_VALIDATED_SOURCE" } }));
  }));
  for (let offset = 0; offset < coverage.length; offset += 500) {
    await prisma.fxCoverage.createMany({ data: coverage.slice(offset, offset + 500), skipDuplicates: true });
  }
  const classifications = pairs.reduce<Record<string, number>>((counts, pair) => ({ ...counts, [pair.classification]: (counts[pair.classification] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ status: "COMPLETE", layer: "L0_L3", sources: config.sources.length, currencies: config.currencies.length, pairs: pairs.length, coverageCells: coverage.length, classifications }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
