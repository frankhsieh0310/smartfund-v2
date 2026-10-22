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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REMAINING_22 = [
  "USDILS", "USDRUB", "USDCLP", "USDCOP", "USDPEN", "USDPKR", "USDLKR", "USDEGP",
  "USDKWD", "USDBHD", "USDOMR", "USDJOD", "USDMAD", "USDNGN", "USDKES", "USDRON",
  "USDBGN", "USDISK", "USDUAH", "USDDOP", "USDCRC", "USDVES",
];

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const { updateFxHistory } = await import("../../lib/cron/fxUpdate");
  const { prisma } = await import("../../lib/prisma");

  const batches = chunk(REMAINING_22, 6); // small batches per task guidance (5-8/batch)
  const allFailed: string[] = [];
  let totalUpdated = 0, totalRows = 0;

  for (const [i, batch] of batches.entries()) {
    console.log(`BATCH ${i + 1}/${batches.length}:`, batch);
    const r = await updateFxHistory(null, batch.length, batch);
    console.log(`  updatedPairs=${r.updatedPairs} rowsWritten=${r.rowsWritten} failed=`, r.failedPairs);
    totalUpdated += r.updatedPairs;
    totalRows += r.rowsWritten;
    allFailed.push(...r.failedPairs.map((f) => f.symbol));
    await sleep(3000); // pace between batches, low pressure on Yahoo
  }

  // Retry failed pairs once, individually, paced.
  if (allFailed.length) {
    console.log("RETRYING FAILED:", allFailed);
    for (const sym of allFailed) {
      const r = await updateFxHistory(null, 1, [sym]);
      console.log(`  retry ${sym}: updatedPairs=${r.updatedPairs} rowsWritten=${r.rowsWritten} failed=`, r.failedPairs);
      totalUpdated += r.updatedPairs;
      totalRows += r.rowsWritten;
      await sleep(2000);
    }
  }

  console.log("TOTAL updatedPairs=", totalUpdated, "totalRowsWritten=", totalRows);

  // Verification: each of the 24 new pairs (2 already done + 22 targeted here).
  const ALL_24 = ["USDARS", "USDBDT", ...REMAINING_22];
  console.log("=== VERIFICATION (24 new pairs) ===");
  for (const sym of ALL_24) {
    const pair = await prisma.fxPair.findUnique({ where: { symbol: sym } });
    const count = await prisma.fxCandle.count({ where: { pairSymbol: sym, interval: "1d", source: "YAHOO_CHART" } });
    const latest = await prisma.fxCandle.findFirst({ where: { pairSymbol: sym, interval: "1d", source: "YAHOO_CHART" }, orderBy: { openTime: "desc" } });
    // duplicate PK check: group by openTime, any count>1 would be a real DB constraint violation
    // (impossible given the PK, but confirm no logical dupes by date just in case of interval drift)
    const dupCheck = await prisma.fxCandle.groupBy({ by: ["openTime"], where: { pairSymbol: sym, interval: "1d", source: "YAHOO_CHART" }, _count: true, having: { openTime: { _count: { gt: 1 } } } });
    console.log(sym, JSON.stringify({
      providerSymbol: pair?.providerSymbol ?? null,
      candleCount: count,
      latestDate: latest?.openTime.toISOString().slice(0, 10) ?? null,
      duplicates: dupCheck.length,
      result: count > 0 ? "PASS" : "FAIL",
    }));
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error("SCRIPT_FAILED", e); process.exit(1); });
