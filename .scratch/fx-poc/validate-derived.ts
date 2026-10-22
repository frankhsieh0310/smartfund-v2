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
  const { updateDerivedFxQuotes } = await import("../../lib/cron/fxDerivedUpdate");
  const { prisma } = await import("../../lib/prisma");

  console.log("=== DERIVED RUN 1 ===");
  const r1 = await updateDerivedFxQuotes();
  console.log(r1);

  console.log("=== DERIVED RUN 2 (idempotency check) ===");
  const r2 = await updateDerivedFxQuotes();
  console.log(r2);

  console.log("=== SPOT CHECK: 5 derived-only pairs ===");
  const rows = await prisma.fxLatestQuote.findMany({ where: { source: "DERIVED_CROSS_RATE" }, take: 5, orderBy: { pairSymbol: "asc" } });
  for (const row of rows) {
    const meta = row.metadata as { leg1Pair?: string; leg2Pair?: string; anchor?: string } | null;
    const leg1 = meta?.leg1Pair ? await prisma.fxLatestQuote.findUnique({ where: { pairSymbol: meta.leg1Pair } }) : null;
    const leg2 = meta?.leg2Pair ? await prisma.fxLatestQuote.findUnique({ where: { pairSymbol: meta.leg2Pair } }) : null;
    console.log(row.pairSymbol, {
      source: row.source,
      quotedAt: row.quotedAt.toISOString(),
      anchor: meta?.anchor,
      leg1: meta?.leg1Pair, leg1QuotedAt: leg1?.quotedAt.toISOString(),
      leg2: meta?.leg2Pair, leg2QuotedAt: leg2?.quotedAt.toISOString(),
      freshnessOk: (!leg1 || row.quotedAt.getTime() <= leg1.quotedAt.getTime()) && (!leg2 || row.quotedAt.getTime() <= leg2.quotedAt.getTime()),
    });
  }

  console.log("=== DIRECT-OVER-DERIVED GUARD CHECK ===");
  const directSymbols = await import("../../lib/cloud-ingestion/fxUniverse").then(m => m.getActiveYahooDirectPairSymbols());
  const directSet = new Set(directSymbols);
  const derivedRows = await prisma.fxLatestQuote.count({ where: { source: "DERIVED_CROSS_RATE", pairSymbol: { in: [...directSet] } } });
  console.log("Derived-sourced rows that landed on a Yahoo-direct pair (should be 0):", derivedRows);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
