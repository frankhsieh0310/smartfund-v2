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
  const REMAINING_22 = ["USDILS","USDRUB","USDCLP","USDCOP","USDPEN","USDPKR","USDLKR","USDEGP","USDKWD","USDBHD","USDOMR","USDJOD","USDMAD","USDNGN","USDKES","USDRON","USDBGN","USDISK","USDUAH","USDDOP","USDCRC","USDVES"];
  const counts = await prisma.fxCandle.groupBy({ by: ["pairSymbol"], where: { pairSymbol: { in: REMAINING_22 } }, _count: true });
  const map = new Map(counts.map(c => [c.pairSymbol, c._count]));
  for (const s of REMAINING_22) console.log(s, map.get(s) ?? 0);
  console.log("done pairs (count>0):", counts.length, "/22");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
