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
  const { getFxList, getFxDetail, getFxHistory } = await import("../../lib/data-platform/web/fxService");
  console.log("=== getFxList({query:'USDTWD'}) ===");
  console.log(JSON.stringify(await getFxList({ query: "USDTWD" }), null, 2));
  console.log("=== getFxDetail('USD/TWD') ===");
  console.log(JSON.stringify(await getFxDetail("USDTWD"), null, 2));
  console.log("=== getFxHistory('USDTWD') first 3 rows ===");
  const h = await getFxHistory("USDTWD", { pageSize: 3 });
  console.log(JSON.stringify({ ...h, data: h.data.slice(0, 3) }, null, 2));
  const { prisma } = await import("../../lib/prisma");
  await prisma.$disconnect();
}
main().catch((e) => { console.error("API_VALIDATION_FAILED", e); process.exit(1); });
