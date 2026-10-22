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
  const { updateFxHistory } = await import("../../lib/cron/fxUpdate");
  const { DISCOVERED_PAIRS, canonicalPairId } = await import("../../lib/cloud-ingestion/fxUniverse");
  const newSymbols = DISCOVERED_PAIRS.map((p) => canonicalPairId(p.base, p.quote));
  console.log("Backfilling", newSymbols.length, "newly-discovered pairs:", newSymbols);
  const r = await updateFxHistory(null, newSymbols.length, newSymbols);
  console.log("BACKFILL RESULT", { requestedPairs: r.requestedPairs, updatedPairs: r.updatedPairs, rowsWritten: r.rowsWritten, failedPairs: r.failedPairs });

  // Idempotency check: rerun immediately, row count should barely move (maybe 0-1 new day if a
  // session just closed between runs).
  const { prisma } = await import("../../lib/prisma");
  const before = await prisma.fxCandle.count({ where: { pairSymbol: { in: newSymbols } } });
  const r2 = await updateFxHistory(null, newSymbols.length, newSymbols);
  const after = await prisma.fxCandle.count({ where: { pairSymbol: { in: newSymbols } } });
  console.log("IDEMPOTENCY CHECK: candle count before rerun =", before, "after rerun =", after, "(should be equal or very close)");
  console.log("rerun result:", { updatedPairs: r2.updatedPairs, rowsWritten: r2.rowsWritten, failedPairs: r2.failedPairs });

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
