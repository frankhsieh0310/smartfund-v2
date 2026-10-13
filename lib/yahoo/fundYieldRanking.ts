// Function 6 only. The offline batch publishes a complete snapshot atomically.
// Page requests never fetch Yahoo and never rank a partially fetched universe.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type FundYieldEntry = { shareClassId: string; code: string; name: string; yahooYield: number | null; checkedAt: string; unavailable?: boolean };
export type FundYieldSnapshot = {
  version: string; source: "YAHOO_DIRECT"; universeCount: number; mappedCount: number;
  checkedCount: number; missingCount: number; failedCount: number; rows: FundYieldEntry[];
};
export const snapshotPath = join(process.cwd(), "data/generated/fund-yahoo-yield-ranking.json");
export function rankFundYields(entries: FundYieldEntry[]) {
  return entries.filter(r => r.yahooYield !== null && Number.isFinite(r.yahooYield) && r.yahooYield >= 0)
    .sort((a,b) => b.yahooYield! - a.yahooYield! || a.shareClassId.localeCompare(b.shareClassId));
}
export function fundYieldPage(snapshot: FundYieldSnapshot, offset: number, limit: number) {
  if (snapshot.source !== "YAHOO_DIRECT" || snapshot.failedCount !== 0 || snapshot.checkedCount !== snapshot.mappedCount || snapshot.rows.length + snapshot.missingCount !== snapshot.mappedCount) {
    throw new Error("Incomplete Yahoo fund yield snapshot");
  }
  return {
    type: "fund", snapshot: snapshot.version, universeCount: snapshot.universeCount,
    mappedCount: snapshot.mappedCount, total: snapshot.rows.length,
    nextOffset: offset + limit < snapshot.rows.length ? offset + limit : null,
    data: snapshot.rows.slice(offset, offset + limit).map(r => ({ ...r, latestDividend: null, exDate: null })),
  };
}
let cache: { until: number; snapshot: FundYieldSnapshot } | undefined;
export async function readFundYieldSnapshot() {
  if (cache && cache.until > Date.now()) return cache.snapshot;
  const snapshot: FundYieldSnapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  fundYieldPage(snapshot, 0, 1);
  cache = { until: Date.now() + 60_000, snapshot };
  return snapshot;
}
