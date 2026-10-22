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
  const totalPairs = await prisma.fxPair.count();
  console.log("total fx_pairs rows (includes pre-existing, not just our 19):", totalPairs);
  const byInterval = await prisma.fxCandle.groupBy({ by: ["interval", "source"], _count: true });
  console.log("fx_candles breakdown by interval/source:", byInterval);
  for (const sym of ["USDTWD", "EURUSD", "USDJPY"]) {
    const mine = await prisma.fxCandle.count({ where: { pairSymbol: sym, interval: "1d", source: "YAHOO_CHART" } });
    const all = await prisma.fxCandle.count({ where: { pairSymbol: sym } });
    const others = await prisma.fxCandle.groupBy({ by: ["interval", "source"], where: { pairSymbol: sym }, _count: true });
    console.log(sym, "mine(1d/YAHOO_CHART)=", mine, "all=", all, "breakdown=", others);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
