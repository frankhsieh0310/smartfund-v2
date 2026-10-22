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
  const pairs = await prisma.fxPair.findMany({ select: { symbol: true, baseCurrency: true, quoteCurrency: true } });
  const currencies = [...new Set(pairs.flatMap((p) => [p.baseCurrency, p.quoteCurrency]))].sort();
  console.log("DISTINCT currencies (", currencies.length, "):", currencies.join(","));
  const maxUnorderedCombos = (currencies.length * (currencies.length - 1)) / 2;
  console.log("C(n,2) unordered combos possible:", maxUnorderedCombos, "vs existing pairs:", pairs.length);

  // unordered key set of existing pairs
  const existingUnordered = new Set(pairs.map((p) => [p.baseCurrency, p.quoteCurrency].sort().join("-")));
  const missing: string[] = [];
  for (let i = 0; i < currencies.length; i++) {
    for (let j = i + 1; j < currencies.length; j++) {
      const key = [currencies[i], currencies[j]].sort().join("-");
      if (!existingUnordered.has(key)) missing.push(key);
    }
  }
  console.log("MISSING unordered currency combos within existing 33-currency set:", missing.length);
  console.log(missing.slice(0, 60));

  const fxCurrencyRows = await prisma.fxCurrency.findMany({ select: { code: true } });
  console.log("fx_currencies table rows:", fxCurrencyRows.length, fxCurrencyRows.map(r=>r.code).sort().join(","));

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
