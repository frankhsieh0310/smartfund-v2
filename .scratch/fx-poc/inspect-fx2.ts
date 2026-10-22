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
  console.log("fx_latest_quotes total:", await prisma.fxLatestQuote.count());
  console.log("fx_pair_aliases total:", await prisma.fxPairAlias.count());
  const byProvider = await prisma.fxPairAlias.groupBy({ by: ["provider"], _count: true });
  console.log("fx_pair_aliases by provider:", byProvider);
  console.log("AUDCAD latest quote (not in our curated 19):", await prisma.fxLatestQuote.findUnique({ where: { pairSymbol: "AUDCAD" } }));
  console.log("AUDCAD alias:", await prisma.fxPairAlias.findMany({ where: { pairSymbol: "AUDCAD" } }));
  console.log("USDTWD alias rows:", await prisma.fxPairAlias.findMany({ where: { pairSymbol: "USDTWD" } }));
  const sample = await prisma.fxLatestQuote.findMany({ take: 5, orderBy: { ingestedAt: "asc" } });
  console.log("5 oldest-ingested fx_latest_quotes rows:", sample.map(s => ({ pairSymbol: s.pairSymbol, source: s.source, quotedAt: s.quotedAt, ingestedAt: s.ingestedAt })));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
