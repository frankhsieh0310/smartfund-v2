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
  const { DISCOVERED_PAIRS, canonicalPairId } = await import("../../lib/cloud-ingestion/fxUniverse");
  const newSymbols = DISCOVERED_PAIRS.map((p) => canonicalPairId(p.base, p.quote));
  const counts = await prisma.fxCandle.groupBy({ by: ["pairSymbol"], where: { pairSymbol: { in: newSymbols } }, _count: true });
  console.log("Partial backfill progress:", counts.length, "of", newSymbols.length, "pairs have at least 1 candle");
  console.log(counts.map(c => `${c.pairSymbol}=${c._count}`).join(", "));
  const missing = newSymbols.filter(s => !counts.find(c => c.pairSymbol === s));
  console.log("Still missing:", missing);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
