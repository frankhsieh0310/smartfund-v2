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
  const { prisma } = await import("../../lib/prisma");

  console.log("=== RESUME TEST: history batch=4, run 1 (cursor=null) ===");
  const r1 = await updateFxHistory(null, 4);
  console.log({ requestedPairs: r1.requestedPairs, updatedPairs: r1.updatedPairs, rowsWritten: r1.rowsWritten, lastSymbol: r1.lastSymbol, wrapped: r1.wrapped, failed: r1.failedPairs });

  console.log("=== RESUME TEST: history batch=4, run 2 (cursor=", r1.lastSymbol, ") ===");
  const r2 = await updateFxHistory(r1.lastSymbol, 4);
  console.log({ requestedPairs: r2.requestedPairs, updatedPairs: r2.updatedPairs, rowsWritten: r2.rowsWritten, lastSymbol: r2.lastSymbol, wrapped: r2.wrapped, failed: r2.failedPairs });

  console.log("RESUMED_PAST_CURSOR:", r1.lastSymbol && r2.lastSymbol ? r2.lastSymbol > r1.lastSymbol : "n/a");

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
